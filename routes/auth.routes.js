const { Router } = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const sanitizeHtml = require("sanitize-html");
const { waitUntil } = require("@vercel/functions");
const { emailSender } = require("../emailSender");
const { verifyToken } = require("../middleware/auth");

const router = Router();

module.exports = ({ usersCollection }) => {
  router.post("/register", async (req, res) => {
    try {
      const {
        name, email, password, contactNo, result,
        passportNumber, transactionId, sex, dateOfBirth,
      } = req.body || {};

      // SECURITY: role/status/isDeleted/mock counts are NEVER taken from the
      // request body on the public registration endpoint — otherwise a client
      // could self-assign `role: "admin"`. Privileged fields are set by the
      // server (below) or via admin-only routes.

      if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ message: "Password must be at least 8 characters" });
      }

      const normalizedEmail = email.toLowerCase();

      const existingUser = await usersCollection.findOne({ email: normalizedEmail });
      if (existingUser) {
        return res.status(400).json({ message: "User already exists" });
      }

      const existingUserByTransactionId = await usersCollection.findOne({ transactionId });
      if (existingUserByTransactionId) {
        return res.status(409).json({ message: "Transaction ID is already in use." });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      const newUser = {
        _id: new ObjectId(),
        name, email: normalizedEmail, contactNo, passportNumber, sex, dateOfBirth,
        password: hashedPassword,
        mock: 0, totalMock: 0, result, transactionId,
        role: "user", status: "active", isDeleted: false,
        createdAt: new Date(), updatedAt: new Date(),
      };

      await usersCollection.insertOne(newUser);

      const subject = "Welcome to Luminedge!";
      const messageContent = `
      <div>
        <p>Dear ${sanitizeHtml(name || "", { allowedTags: [], allowedAttributes: {} })},</p>
        <p>Thank you for registering on the Luminedge Mock Booking Portal. Your account has been successfully created!</p>
        <p>Our team will now verify your proof of payment (Money Receipt) details. Once verified, you will be granted access to book your mock tests directly through the portal.</p>
        <p>If any additional information is required, we will contact you promptly. Please allow up to 48 hours for the verification process.</p>
        <p>For any urgent queries, feel free to reach out to us at 📞 01400-403485 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494.</p>
        <p>Thank you for choosing Luminedge, and we wish you the best in your test preparation journey!</p>
        <p>Best regards,</p>
        <p>The Luminedge Team</p>
      </div>
    `;

      // Fire-and-forget: SMTP trouble (slow/unreachable host) must never delay
      // the registration response, which has already succeeded at this point.
      // waitUntil keeps the serverless invocation alive until this settles —
      // without it, Vercel can freeze the execution context right after the
      // response is sent, and the email send/retry may never actually run.
      waitUntil(
        emailSender(subject, normalizedEmail, messageContent)
          .then((result) => {
            if (!result.success) {
              console.warn(
                `⚠️  Welcome email failed for ${normalizedEmail}:`,
                result.error?.message || result.error
              );
            }
          })
          .catch((err) =>
            console.error("Unexpected error sending welcome email:", err)
          )
      );

      res.status(201).json({ message: "User registered successfully", userId: newUser._id });
    } catch (error) {
      // The findOne existence checks above are not atomic, so two concurrent
      // registrations with the same email can both pass them. The unique
      // {email} index is the real guard: a duplicate insert throws E11000 —
      // treat it as "already exists" rather than a generic 500.
      if (error?.code === 11000) {
        return res.status(409).json({ message: "User already exists" });
      }
      console.error("Error during registration process:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      const { email, password } = req.body || {};

      if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const user = await usersCollection.findOne({ email: email.toLowerCase() });
      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ message: "Invalid email or password" });
      }

      // Default to a 7-day session so tokens don't die every hour and drop
      // clients into a 401 polling loop.
      const EXPIRES_IN = process.env.EXPIRES_IN || "7d";

      const token = jwt.sign(
        { email: user.email, userId: user._id, role: user.role },
        process.env.JWT_SECRET,
        { expiresIn: EXPIRES_IN }
      );

      // Derive the cookie lifetime from the token's ACTUAL expiry so the two can
      // never diverge: if EXPIRES_IN is set short (e.g. "1h"), the cookie also
      // expires in 1h and the browser stops sending it — instead of shipping an
      // already-expired token and re-creating the 401 loop.
      const decoded = jwt.decode(token);
      const SESSION_MS =
        decoded && decoded.exp
          ? decoded.exp * 1000 - Date.now()
          : 7 * 24 * 60 * 60 * 1000;

      res.cookie("token", token, {
        httpOnly: true,
        maxAge: SESSION_MS,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "None" : "Lax",
      });

      res.json({
        success: true,
        accessToken: token,
        email: user.email,
        role: user.role,
        userId: user._id.toString(),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/forget-password", async (req, res) => {
    try {
      const { email } = req.body || {};

      if (typeof email !== "string" || !email) {
        return res.status(400).json({ success: false, message: "Email is required" });
      }

      // SECURITY: always return the SAME response whether or not the account
      // exists, so this endpoint can't be used to enumerate registered emails
      // (or to spam arbitrary inboxes). The email is sent only when a matching
      // user is found. The exact message string is kept identical to the
      // original success response because the frontend matches on it verbatim.
      const genericResponse = {
        success: true,
        message: "Password reset link sent successfully",
      };

      const userData = await usersCollection.findOne({ email: email.toLowerCase() });

      if (!userData) {
        return res.json(genericResponse);
      }

      const resetPassToken = jwt.sign(
        { email: userData.email, userId: userData._id },
        process.env.JWT_RESET_PASS_SECRET,
        { expiresIn: process.env.JWT_RESET_PASS_TOKEN_EXPIRES_IN || "15m" }
      );

      const resetPassLink = `${process.env.RESET_PASS_LINK}?userId=${userData._id}&token=${resetPassToken}`;

      const subject = "Password Reset Request - Luminedge";
      const content = `
      <div>
        <p>Dear ${sanitizeHtml(userData.name || "", { allowedTags: [], allowedAttributes: {} })},</p>
        <p>We received a request to reset your password. Click the button below to proceed:</p>
        <a href="${resetPassLink}" style="text-decoration: none;">
          <button style="background-color: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
            Reset Password
          </button>
        </a>
        <p>If the button above does not work, copy and paste this link into your browser:</p>
        <p>${resetPassLink}</p>
        <p>Thank you,</p>
        <p>The Luminedge Team</p>
      </div>
    `;

      res.json(genericResponse);

      // Fire-and-forget (see the /register handler above for why): this mail
      // host's pipeline takes ~9s per message, so waiting on it here would
      // risk the response itself blowing Vercel's function timeout.
      waitUntil(
        emailSender(subject, userData.email, content).then((emailResult) => {
          if (!emailResult?.success) {
            // Log loudly for ops so a broken email pipeline is visible, but the
            // response above is already sent identically either way: a distinct
            // error here would only ever fire for existing accounts and thus
            // reintroduce the enumeration leak this endpoint was hardened against.
            console.error(
              `Password reset email failed for ${userData.email}:`,
              emailResult?.error
            );
          }
        })
      );
    } catch (error) {
      console.error("Error in forget-password route:", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  });

  router.put("/auth/reset-password", async (req, res) => {
    try {
      const { userId, token, newPassword } = req.body || {};

      if (!userId || !token || typeof newPassword !== "string" || !newPassword) {
        return res.status(400).json({ success: false, message: "All fields are required" });
      }

      if (!ObjectId.isValid(String(userId))) {
        return res.status(400).json({ success: false, message: "Invalid user ID" });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_RESET_PASS_SECRET);
      } catch (error) {
        return res.status(400).json({ success: false, message: "Invalid or expired token!" });
      }

      if (decoded.userId.toString() !== String(userId)) {
        return res.status(400).json({ success: false, message: "Token mismatch!" });
      }

      const userData = await usersCollection.findOne({ _id: new ObjectId(userId) });

      if (!userData) {
        return res.status(404).json({ success: false, message: "User not found or inactive!" });
      }

      // SECURITY: make the reset link effectively single-use. If the password
      // was already changed after this token was issued, reject it — a captured
      // or resent link can't reset the password a second time.
      if (userData.passwordChangedAt && decoded.iat) {
        const changedAtSec = Math.floor(new Date(userData.passwordChangedAt).getTime() / 1000);
        if (decoded.iat < changedAtSec) {
          return res.status(400).json({ success: false, message: "This reset link has already been used." });
        }
      }

      const hashedPassword = await bcrypt.hash(newPassword, 12);

      await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { password: hashedPassword, passwordChangedAt: new Date() } }
      );

      res.json({ success: true, message: "Password reset successfully" });
    } catch (error) {
      console.error("Error in reset-password route:", error);
      res.status(500).json({ success: false, message: "Internal Server Error" });
    }
  });

  // Authenticated: user can only change their own password
  router.put("/user/change-password", verifyToken, async (req, res) => {
    try {
      const { email, oldPassword, newPassword } = req.body || {};
      if (typeof email !== "string" || typeof oldPassword !== "string" || typeof newPassword !== "string" || !email || !oldPassword || !newPassword) {
        return res.status(400).json({ message: "Email, oldPassword, newPassword are required" });
      }

      if (email.toLowerCase() !== req.user.email.toLowerCase()) {
        return res.status(403).json({ message: "Forbidden" });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({ message: "New password must be at least 8 characters" });
      }

      // Match by the authenticated email only. verifyToken already rejected
      // blocked/deleted accounts, so an extra status filter here would wrongly
      // lock out verified users (whose status is not "active").
      const user = await usersCollection.findOne({ email: email.toLowerCase() });
      if (!user) return res.status(404).json({ message: "User not found" });

      const ok = await bcrypt.compare(oldPassword, user.password);
      if (!ok) return res.status(401).json({ message: "Password incorrect" });

      const hashed = await bcrypt.hash(newPassword, 12);
      await usersCollection.updateOne(
        { _id: user._id },
        { $set: { password: hashed, needPasswordChange: false, passwordChangedAt: new Date() } }
      );
      return res.json({ message: "Password changed successfully!" });
    } catch (e) {
      console.error("change-password error:", e);
      return res.status(500).json({ message: "Server error" });
    }
  });

  return router;
};
