import { waitUntil } from "@vercel/functions";
import sanitizeHtml from "sanitize-html";
import { emailSender } from "../../../emailSender";
import type { AuthEmailSender } from "../modules/auth/auth.types";

function sanitizeName(name: unknown): string {
  return sanitizeHtml(typeof name === "string" ? name : "", {
    allowedTags: [],
    allowedAttributes: {},
  });
}

export const legacyEmailSender: AuthEmailSender = {
  sendWelcomeEmail(email: string, name: unknown): void {
    const subject = "Welcome to Luminedge!";
    const messageContent = `
      <div>
        <p>Dear ${sanitizeName(name)},</p>
        <p>Thank you for registering on the Luminedge Mock Booking Portal. Your account has been successfully created!</p>
        <p>Our team will now verify your proof of payment (Money Receipt) details. Once verified, you will be granted access to book your mock tests directly through the portal.</p>
        <p>If any additional information is required, we will contact you promptly. Please allow up to 48 hours for the verification process.</p>
        <p>For any urgent queries, feel free to reach out to us at 📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494.</p>
        <p>Thank you for choosing Luminedge, and we wish you the best in your test preparation journey!</p>
        <p>Best regards,</p>
        <p>The Luminedge Team</p>
      </div>
    `;

    waitUntil(
      emailSender(subject, email, messageContent)
        .then((result: { success: boolean; error?: { message?: string } | unknown }) => {
          if (!result.success) {
            console.warn(`⚠️  Welcome email failed for ${email}:`, (result.error as { message?: string })?.message || result.error);
          }
        })
        .catch((err: unknown) => console.error("Unexpected error sending welcome email:", err))
    );
  },

  sendPasswordResetEmail(email: string, name: unknown, resetLink: string): void {
    const subject = "Password Reset Request - Luminedge";
    const content = `
      <div>
        <p>Dear ${sanitizeName(name)},</p>
        <p>We received a request to reset your password. Click the button below to proceed:</p>
        <a href="${resetLink}" style="text-decoration: none;">
          <button style="background-color: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
            Reset Password
          </button>
        </a>
        <p>If the button above does not work, copy and paste this link into your browser:</p>
        <p>${resetLink}</p>
        <p>Thank you,</p>
        <p>The Luminedge Team</p>
      </div>
    `;

    waitUntil(
      emailSender(subject, email, content).then((emailResult: { success: boolean; error?: unknown }) => {
        if (!emailResult?.success) {
          console.error(`Password reset email failed for ${email}:`, emailResult?.error);
        }
      })
    );
  },
};
