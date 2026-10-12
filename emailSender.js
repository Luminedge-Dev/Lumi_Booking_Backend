const crypto = require("crypto");
const nodemailer = require("nodemailer");

const smtpUser = () => process.env.EMAIL || process.env.SMTP_EMAIL || "";
const smtpPass = () => process.env.APP_PASS || process.env.SMTP_APP_PASS || "";

function smtpConnection() {
  const port = Number(process.env.SMTP_PORT || 587);
  const requestedSecure = process.env.SMTP_SECURE === "true";
  if (port === 465) return { port, secure: true, requestedSecure };
  if (port === 587) return { port, secure: false, requestedSecure };
  return { port, secure: requestedSecure, requestedSecure };
}

function messageIdDomain() {
  const from = process.env.EMAIL_FROM || smtpUser();
  const match = String(from).match(/@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
  return match ? match[1] : "localhost";
}

let transporter;
const getTransporter = () => {
  if (!transporter) {
    const connection = smtpConnection();
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: connection.port,
      secure: connection.secure,
      auth: {
        user: smtpUser(),
        pass: smtpPass(),
      },
      pool: true,
      maxRequeues: 0,
      maxConnections: 4,
      maxMessages: 100,
      connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: {
        rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== "false",
      },
    });
  }
  return transporter;
};

const FROM = () => `Luminedge <${process.env.EMAIL_FROM || smtpUser()}>`;

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

const SAFE_RETRY_COMMAND_PREFIXES = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL", "RCPT"];
const isSafeRetryPhase = (command) =>
  typeof command === "string" &&
  SAFE_RETRY_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));

const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ECONNRESET",
  "ESOCKET",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

  const isRetryable = (err) => {
  if (!isSafeRetryPhase(err?.command)) return false;

  if (RETRYABLE_CODES.has(err?.code)) return true;
  if (typeof err?.responseCode === "number") {
    return err.responseCode >= 400 && err.responseCode < 500;
  }
  return false;
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

const emailSender = async (subject, to, content, attachments, options) => {
  const deadlineMs = options?.deadlineMs ?? EMAIL_OPERATION_DEADLINE_MS;
  try {
    if (!subject || !to || !content) {
      throw new Error("Missing required fields: subject, to, or content");
    }
    if (!process.env.SMTP_HOST || !smtpUser() || !smtpPass()) {
      throw new Error("SMTP is not configured (SMTP_HOST and EMAIL or SMTP_EMAIL, and APP_PASS or SMTP_APP_PASS)");
    }

    const messageId = `<${crypto.randomUUID()}@${messageIdDomain()}>`;

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

const logEmailOutcome = (context, result) => {
  if (result.success) {
    console.log(`📩 ${context} succeeded.`);
  } else {
    console.warn(`⚠️  ${context} failed:`, result.error?.message || result.error);
  }
  return result;
};

const VERCEL_FUNCTION_TIMEOUT_MS = 60_000;
const BULK_SEND_BUDGET_MS = VERCEL_FUNCTION_TIMEOUT_MS - 5_000;

const BULK_ITEM_DEADLINE_MS = 15_000;


const BULK_CONCURRENCY = 3;

const emailSenderBulk = async (items, gapMs = 550) => {
  if (!process.env.SMTP_HOST || !smtpUser() || !smtpPass()) {
    return items.map(() => ({
      success: false,
      error: new Error("SMTP is not configured (SMTP_HOST and EMAIL or SMTP_EMAIL, and APP_PASS or SMTP_APP_PASS)"),
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

module.exports = { emailSender, emailSenderBulk, logEmailOutcome, smtpConnection };
