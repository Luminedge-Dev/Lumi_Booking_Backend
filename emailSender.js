const crypto = require("crypto");
const nodemailer = require("nodemailer");

// SMTP-based email via Nodemailer. Requires SMTP_HOST, EMAIL, APP_PASS.
// From address uses EMAIL_FROM or EMAIL.
//
// The transporter is created lazily and cached at module scope so a missing/
// invalid SMTP config never crashes the app at import time (which would break
// server startup on serverless), and a warm serverless invocation reuses the
// same pooled connections instead of reconnecting on every request.
let transporter;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true", // false => STARTTLS on 587; true => implicit TLS on 465
      auth: {
        user: process.env.EMAIL,
        pass: process.env.APP_PASS,
      },
      pool: true,
      // Nodemailer's pool auto-requeues a message on an unexpected connection
      // close by default (maxRequeues unset = unlimited), independent of and
      // regardless of whether the server already accepted DATA — this can
      // double-send even when isSafeRetryPhase()/isRetryable() below would
      // have refused to retry. Disable it entirely so retry decisions flow
      // only through our own command-phase gate.
      maxRequeues: 0,
      // One connection above BULK_CONCURRENCY (below) so a standalone send
      // (e.g. a booking confirmation) fired while a bulk send is using every
      // bulk-reserved connection doesn't have to queue behind unrelated bulk
      // traffic and risk its own EMAIL_OPERATION_DEADLINE_MS for no reason
      // related to its own recipient's mail server.
      maxConnections: 4,
      maxMessages: 100,
      connectionTimeout: 10_000, // time to establish TCP+TLS to the SMTP host
      greetingTimeout: 10_000, // time to wait for the SMTP greeting/EHLO after connect
      // mail.luminedge.com.bd holds every accepted message in a synchronous
      // MailScanner scan before returning the final SMTP response — confirmed
      // via its own SMTP log to take ~9-10s consistently, every message, not
      // occasionally. socketTimeout must stay safely above that (and above
      // EMAIL_OPERATION_DEADLINE_MS / BULK_ITEM_DEADLINE_MS below) or
      // Nodemailer would tear down a perfectly healthy, still-scanning
      // connection before the server ever gets to respond.
      socketTimeout: 20_000, // see EMAIL_OPERATION_DEADLINE_MS below — must stay clearly under it
      tls: {
        // Escape hatch only — leave unset/"true" unless a real certificate problem is observed.
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
      },
    });
  }
  return transporter;
};

const FROM = () => `Luminedge <${process.env.EMAIL_FROM || process.env.EMAIL}>`;

// Nodemailer accepts Buffers/Streams directly, so attachments pass through
// with no base64 conversion. A string `content` is only safe to forward when
// the caller tells us how it's encoded (e.g. "base64") — otherwise Nodemailer
// treats a bare string as literal UTF-8 text, silently corrupting anything
// that was actually meant to be decoded (e.g. a base64 PDF), so we fail fast
// instead of sending a broken attachment.
const mapAttachments = (attachments) =>
  attachments.map((a) => {
    if (!Buffer.isBuffer(a.content)) {
      if (typeof a.content === "string" && !a.encoding) {
        throw new Error(
          "Attachment content is a string but no 'encoding' was specified — pass a Buffer or set encoding"
        );
      }
    }
    return {
      filename: a.filename,
      content: a.content,
      ...(a.encoding ? { encoding: a.encoding } : {}),
      ...(a.contentType || a.content_type
        ? { contentType: a.contentType || a.content_type }
        : {}),
      ...(a.contentDisposition ? { contentDisposition: a.contentDisposition } : {}),
    };
  });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry only clearly transient SMTP/network failures, and only when the
// failure happened before the message body was ever sent to the server. SMTP
// errors expose `.command` — the protocol phase in progress when the error
// occurred (e.g. "CONN", "EHLO", "AUTH LOGIN", "MAIL FROM", "RCPT TO",
// "DATA"). Only CONN/EHLO/AUTH/MAIL/RCPT are safe to retry: nothing the
// server could have already accepted and acted on. HELO/STARTTLS are also
// pre-DATA and safe: Nodemailer falls back from EHLO to HELO on a non-2xx
// EHLO response, and STARTTLS negotiation happens before authentication —
// both surface with err.command === "HELO" / "STARTTLS" respectively. A
// failure during DATA (or with no command at all — an error we don't
// recognize) is NEVER retried, because the server may have already received
// and accepted the message; an automatic resend at that point risks
// delivering the same email twice with no way to tell.
const SAFE_RETRY_COMMAND_PREFIXES = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT"];
const isSafeRetryPhase = (command) =>
  typeof command === "string" &&
  SAFE_RETRY_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));

// Nodemailer errors also expose `.code` (transport-level, e.g. "EAUTH",
// "ECONNECTION") and, when the server actually responded, `.responseCode`
// (the raw SMTP numeric, e.g. 421/450/550). These are only consulted once
// isSafeRetryPhase() has already confirmed the failure happened pre-DATA.
const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ECONNRESET",
  "ESOCKET",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

const isRetryable = (err) => {
  // Command gate takes precedence: never retry a failure that occurred
  // during or after DATA, or one whose phase we can't identify.
  if (!isSafeRetryPhase(err?.command)) return false;

  if (RETRYABLE_CODES.has(err?.code)) return true;
  if (typeof err?.responseCode === "number") {
    return err.responseCode >= 400 && err.responseCode < 500; // 4xx = transient, 5xx = permanent
  }
  return false; // unknown error, no code, no SMTP response — fail fast, never auto-retry
};

const sendWithRetry = async (payload, retries = 2) => {
  for (let i = 0; i <= retries; i++) {
    try {
      return await getTransporter().sendMail(payload);
    } catch (err) {
      if (i === retries || !isRetryable(err)) throw err;
      console.warn(`📨 Retry ${i + 1} failed: ${err.message}`);
      await delay(1000 * (i + 1));
    }
  }
};

// This wraps the whole retry sequence (all attempts + backoff) in a single
// external deadline so one slow/hanging SMTP server can never make
// emailSender hang indefinitely, regardless of the underlying socket-level
// timeouts. This does not cancel an in-flight sendMail (Nodemailer has no
// abort primitive for it) — a hung attempt keeps running in the background,
// bounded by its own socket timeout (see socketTimeout above), but
// emailSender itself stops waiting on it and returns a failure.
//
// mail.luminedge.com.bd's own SMTP log confirms every send consistently
// takes ~9-10s (synchronous MailScanner scanning before the final SMTP
// response), so this must clear that with real margin. Almost every caller
// now fires this via waitUntil() rather than awaiting it inline before an
// HTTP response (see routes/auth.routes.js's /register handler for the
// pattern), so this is no longer racing a tight request/response window —
// it only needs to fit inside the function's overall invocation ceiling.
//
// Must stay clearly above socketTimeout (20_000ms, see getTransporter above):
// both timers start at roughly the same moment, so if they were equal
// whichever fires first would be a coin flip, and losing that race here
// produces an EOPDEADLINE error (no `.command`, so isSafeRetryPhase() never
// retries it) even when the connection would have delivered the message a
// moment later. 5s of margin comfortably covers connection/network overhead
// on top of the confirmed ~9-10s scan.
const EMAIL_OPERATION_DEADLINE_MS = 25_000;

const withDeadline = (promise, ms, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: "EOPDEADLINE" }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });

// `options.deadlineMs` is an optional internal override (defaults to
// EMAIL_OPERATION_DEADLINE_MS) used only by emailSenderBulk below, so a
// single slow item can't consume the whole bulk-send budget. Every existing
// 3/4-argument caller is unaffected.
const emailSender = async (subject, to, content, attachments, options) => {
  const deadlineMs = options?.deadlineMs ?? EMAIL_OPERATION_DEADLINE_MS;
  try {
    if (!subject || !to || !content) {
      throw new Error("Missing required fields: subject, to, or content");
    }
    if (!process.env.SMTP_HOST || !process.env.EMAIL || !process.env.APP_PASS) {
      throw new Error("SMTP is not configured (SMTP_HOST/EMAIL/APP_PASS)");
    }

    // Generated once per logical send operation, before the retry loop, and
    // reused unchanged on every retry attempt (the payload object is never
    // rebuilt between attempts) — a resend of the same operation always
    // carries the same Message-ID rather than minting a new one per attempt.
    const messageId = `<${crypto.randomUUID()}@luminedge.io>`;

    const info = await withDeadline(
      sendWithRetry({
        from: FROM(),
        to,
        subject,
        html: content,
        messageId,
        ...(attachments?.length ? { attachments: mapAttachments(attachments) } : {}),
      }),
      deadlineMs,
      `Email send to ${to} exceeded ${deadlineMs}ms deadline`
    );

    console.log(`📩 Email sent to ${to}: ${info?.messageId || messageId}`);
    return { success: true, info };
  } catch (error) {
    console.error(`❌ Final email failure to ${to}:`, error.message);
    return { success: false, error };
  }
};

// Logs the outcome of an emailSender() result under a caller-supplied label,
// and returns the result unchanged so callers can keep using it (e.g.
// `result.success`) exactly as before.
const logEmailOutcome = (context, result) => {
  if (result.success) {
    console.log(`📩 ${context} succeeded.`);
  } else {
    console.warn(`⚠️  ${context} failed:`, result.error?.message || result.error);
  }
  return result;
};

// This project's Vercel Function Max Duration is configured at 60s (the
// Hobby plan's maximum — raised from the previous 10s default specifically
// to accommodate mail.luminedge.com.bd's confirmed ~9-10s-per-message send
// time). The bulk send budget below leaves 5s headroom for request/response
// overhead and firing the self-continuation call (see /send-reminder in
// routes/booking.routes.js) outside this function, so a large recipient list
// fails fast and reports accurate partial results instead of risking the
// whole invocation timing out with no response at all.
const VERCEL_FUNCTION_TIMEOUT_MS = 60_000;
const BULK_SEND_BUDGET_MS = VERCEL_FUNCTION_TIMEOUT_MS - 5_000;

// Bulk items get a shorter per-item deadline than a standalone emailSender()
// call, but still comfortably above the confirmed ~9-10s this mail host's
// synchronous MailScanner scan takes per message. Invariant this whole
// module relies on: a worker is only allowed to START an item when the time
// left in BULK_SEND_BUDGET_MS is already >= BULK_ITEM_DEADLINE_MS (see the
// gate in `worker` below) — so the worst case for any single item is that it
// consumes exactly its own deadline, never more. That bounds total wall time
// to BULK_SEND_BUDGET_MS itself, not BULK_SEND_BUDGET_MS +
// BULK_ITEM_DEADLINE_MS. If the gate is ever changed to check remaining time
// only *after* starting an item (or uses `>` where `>=` is required), this
// bound no longer holds.
const BULK_ITEM_DEADLINE_MS = 15_000;

// There is no SMTP batch-send primitive, so bulk sending uses a bounded-
// concurrency worker pool (sized to match the pooled transporter's
// maxConnections, with 1 connection held back for standalone sends — see
// maxConnections above) instead of Promise.all — this avoids opening more
// concurrent SMTP connections than the transport actually supports, or
// overwhelming the mail server with an unbounded fan-out.
// Kept at the same value the app already ran with in production (pre-dating
// this file's SMTP migration) rather than a guessed increase — raise it only
// after confirming mail.luminedge.com.bd actually tolerates more than 3
// concurrent authenticated connections.
const BULK_CONCURRENCY = 3;

const emailSenderBulk = async (items, gapMs = 550) => {
  if (!process.env.SMTP_HOST || !process.env.EMAIL || !process.env.APP_PASS) {
    return items.map(() => ({
      success: false,
      error: new Error("SMTP is not configured (SMTP_HOST/EMAIL/APP_PASS)"),
    }));
  }

  const startedAt = Date.now();
  const results = new Array(items.length);
  let nextIndex = 0;
  let budgetExceeded = false;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;

      const remaining = BULK_SEND_BUDGET_MS - (Date.now() - startedAt);
      if (budgetExceeded || remaining < BULK_ITEM_DEADLINE_MS) {
        budgetExceeded = true;
        results[i] = { success: false, error: new Error("Skipped: send time budget exceeded") };
        continue;
      }

      const { subject, to, content, attachments } = items[i];
      results[i] = await emailSender(subject, to, content, attachments, {
        deadlineMs: BULK_ITEM_DEADLINE_MS,
      });
      // Skip the gap when nothing remains in the shared queue — delaying
      // after the last item just stretches total wall time for no benefit.
      if (gapMs && nextIndex < items.length) await delay(gapMs);
    }
  };

  const workers = Array.from({ length: Math.min(BULK_CONCURRENCY, items.length) }, worker);
  await Promise.all(workers);

  if (budgetExceeded) {
    console.warn("📨 Send time budget hit; some emails were skipped.");
  }

  return results;
};

module.exports = { emailSender, emailSenderBulk, logEmailOutcome };
