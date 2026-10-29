const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

// Injected once at boot via initAuth() so verifyToken can check live account
// state (blocked/deleted, password-changed) without every route having to pass
// the collection in. Kept optional: if it's never initialized, verifyToken
// falls back to signature-only verification (previous behaviour).
let usersCollection = null;

// Staff role set used by every staff-aware guard in this file.
const STAFF_ROLES = ["admin", "bdm", "teacher"];

function initAuth(collection) {
  usersCollection = collection;
}

// Re-check the account behind a valid JWT: a signed token alone is not enough
// because a user can be blocked/deleted, or change their password, mid-session
// (tokens live 7 days). Returns { ok, code } — never throws.
// `live: true` means the account was actually read from MongoDB in this
// request, so `role`/`email` are current values and may be trusted over the
// token claims. Guards that must not act on a token-only identity (e.g. the
// teacher feedback writer) require `live === true`.
async function checkAccountState(decoded) {
  if (!usersCollection || !decoded?.userId || !ObjectId.isValid(String(decoded.userId))) {
    return { ok: true, live: false };
  }

  const user = await usersCollection.findOne(
    { _id: new ObjectId(String(decoded.userId)) },
    { projection: { isDeleted: 1, status: 1, role: 1, email: 1, passwordChangedAt: 1 } }
  );

  if (!user) return { ok: false, code: "ACCOUNT_NOT_FOUND" };
  if (user.isDeleted === true || String(user.status).toLowerCase() === "blocked") {
    return { ok: false, code: "ACCOUNT_BLOCKED" };
  }

  // Invalidate tokens issued before the last password change.
  if (user.passwordChangedAt && decoded.iat) {
    const changedAtSec = Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
    if (decoded.iat < changedAtSec) {
      return { ok: false, code: "TOKEN_STALE" };
    }
  }

  // Trust the live account over whatever was baked into the token: role, email
  // and the identity itself all come from the document that was just read.
  return { ok: true, live: true, id: String(user._id), role: user.role, email: user.email };
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token =
    req.cookies?.token ||
    (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null);

  if (!token) return res.status(401).json({ message: "Unauthorized", code: "NO_TOKEN" });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    const expired = err.name === "TokenExpiredError";
    return res.status(401).json({
      message: expired ? "Token expired" : "Invalid token",
      code: expired ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
    });
  }

  try {
    const state = await checkAccountState(decoded);
    if (!state.ok) {
      return res.status(401).json({ message: "Session no longer valid", code: state.code });
    }
    // Prefer live role/email so a demoted/promoted user, or an account whose
    // email changed after the token was issued, is handled correctly. When the
    // live account could not be read we keep the token claims but flag the
    // identity as unverified so strict guards can fail closed.
    req.user = state.live
      ? {
          ...decoded,
          userId: state.id,
          role: state.role,
          email: typeof state.email === "string" ? state.email : "",
          identityVerified: true,
        }
      : { ...decoded, identityVerified: false };
    next();
  } catch (err) {
    console.error("Auth account-state check failed:", err.message);
    return res.status(500).json({ message: "Authentication error" });
  }
}

// Legacy privileged guards. They used to trust `req.user.role` on the strength
// of the token signature alone, which meant a cryptographically valid JWT could
// authorise admin/staff work even when the live account could not be read (e.g.
// `initAuth` never ran, or the id claim no longer resolves to a document). The
// collective rule for the whole hotfix is now: a privileged decision requires an
// identity that was read from the database during THIS request. Role checks are
// unchanged — admin-only stays admin-only, staff stays admin/bdm/teacher.
function verifyAdmin(req, res, next) {
  verifyToken(req, res, () => {
    requireVerifiedIdentity(req, res, () => {
      if (req.user?.role !== "admin") {
        return res.status(403).json({ message: "Forbidden: admins only" });
      }
      next();
    });
  });
}

function verifyStaff(req, res, next) {
  verifyToken(req, res, () => {
    requireVerifiedIdentity(req, res, () => {
      if (!STAFF_ROLES.includes(req.user?.role)) {
        return res.status(403).json({ message: "Forbidden: staff only" });
      }
      next();
    });
  });
}

// Teacher feedback writers. `teacher` and `admin` are the only roles the UI
// uses to submit feedback/marks. The caller must additionally be the teacher
// assigned to the requested segment; that check lives in the route because it
// needs the booking's schedule. Fails closed when the live account could not be
// read, so a valid-but-unverifiable token can never authorise a write.
function verifyTeacherOrAdmin(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user?.identityVerified !== true || !req.user?.email) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: verified teacher identity required.",
      });
    }
    if (!["teacher", "admin"].includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Forbidden: teachers or admins only." });
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// FIX-03 — record ownership guards
// ---------------------------------------------------------------------------

// Run AFTER verifyToken. Read/write guards that act on a student's records must
// only trust a role that was read from the database during this request: a
// token alone could carry a role that was revoked minutes ago.
function requireVerifiedIdentity(req, res, next) {
  if (req.user?.identityVerified !== true) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: verified account identity required.",
    });
  }
  next();
}

// True when two user identifiers refer to the same account. Exact string match
// first (the common case: both come from the same stored id), then ObjectId
// equality so hex casing cannot be used to dodge the check.
function isSameUser(a, b) {
  if (a == null || b == null) return false;
  if (String(a) === String(b)) return true;
  if (ObjectId.isValid(String(a)) && ObjectId.isValid(String(b))) {
    return String(new ObjectId(String(a))) === String(new ObjectId(String(b)));
  }
  return false;
}

// Owner-or-staff guard for routes carrying a `:userId`-style parameter.
// - any verified student/user may read only their own record;
// - admin / bdm / teacher keep the access their dashboards need;
// - unverifiable identity fails closed (403), never "allow by default".
function ownerOrStaff(param = "userId") {
  return function (req, res, next) {
    verifyToken(req, res, () => {
      if (req.user?.identityVerified !== true) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: verified account identity required.",
        });
      }
      if (STAFF_ROLES.includes(req.user?.role)) return next();

      const target = req.params?.[param];
      if (!isSameUser(target, req.user?.userId)) {
        return res.status(403).json({
          success: false,
          message: "Forbidden: you may only access your own records.",
        });
      }
      next();
    });
  };
}

// Staff-only guard (e.g. the teacher-assignment map). Fails closed when the live
// account identity could not be verified, unlike the legacy `verifyStaff`.
function staffOnly(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user?.identityVerified !== true) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: verified account identity required.",
      });
    }
    if (!STAFF_ROLES.includes(req.user?.role)) {
      return res.status(403).json({ success: false, message: "Forbidden: staff only." });
    }
    next();
  });
}

module.exports = {
  initAuth,
  verifyToken,
  verifyAdmin,
  verifyStaff,
  verifyTeacherOrAdmin,
  requireVerifiedIdentity,
  ownerOrStaff,
  staffOnly,
};
