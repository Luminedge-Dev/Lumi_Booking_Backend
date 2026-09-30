const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");

// Injected once at boot via initAuth() so verifyToken can check live account
// state (blocked/deleted, password-changed) without every route having to pass
// the collection in. Kept optional: if it's never initialized, verifyToken
// falls back to signature-only verification (previous behaviour).
let usersCollection = null;

function initAuth(collection) {
  usersCollection = collection;
}

// Re-check the account behind a valid JWT: a signed token alone is not enough
// because a user can be blocked/deleted, or change their password, mid-session
// (tokens live 7 days). Returns { ok, code } — never throws.
async function checkAccountState(decoded) {
  if (!usersCollection || !decoded?.userId || !ObjectId.isValid(String(decoded.userId))) {
    return { ok: true };
  }

  const user = await usersCollection.findOne(
    { _id: new ObjectId(String(decoded.userId)) },
    { projection: { isDeleted: 1, status: 1, role: 1, passwordChangedAt: 1 } }
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

  // Trust the live role over whatever was baked into the token.
  return { ok: true, role: user.role };
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
    // Prefer the live role so a demoted/promoted user is handled correctly.
    req.user = state.role ? { ...decoded, role: state.role } : decoded;
    next();
  } catch (err) {
    console.error("Auth account-state check failed:", err.message);
    return res.status(500).json({ message: "Authentication error" });
  }
}

function verifyAdmin(req, res, next) {
  verifyToken(req, res, () => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: admins only" });
    }
    next();
  });
}

function verifyStaff(req, res, next) {
  verifyToken(req, res, () => {
    const allowed = ["admin", "bdm", "teacher"];
    if (!allowed.includes(req.user?.role)) {
      return res.status(403).json({ message: "Forbidden: staff only" });
    }
    next();
  });
}

module.exports = { initAuth, verifyToken, verifyAdmin, verifyStaff };
