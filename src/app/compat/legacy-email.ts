import { waitUntil } from "@vercel/functions";
import sanitizeHtml from "sanitize-html";
import { emailSender } from "../../../emailSender";
import type { AuthEmailSender } from "../modules/auth/auth.types";
import type { BookingNotifier } from "../modules/booking/booking.service";
import type { BookedRecord } from "../modules/booking/booking.types";
import type { UserNotifier } from "../modules/user/user.service";
import type { MockGrantEntry } from "../modules/user/user.types";
import { logEmailOutcome } from "../../../emailSender";

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

// Stage 16: booking e-mail intents. Templates are ported verbatim from
// routes/booking.routes.js (no redesign; Stage 19 owns e-mail modernization).
// The booking service calls these only after the PostgreSQL transaction has
// committed, and a failure here never changes the HTTP result.
function convertTo12HourFormat(timeString: string | undefined): string {
  if (!timeString) return "Not Available";
  const [hours, minutes] = timeString.split(":").map(Number);
  const ampm = hours >= 12 ? "PM" : "AM";
  const formattedHours = hours % 12 || 12;
  return `${formattedHours}:${minutes.toString().padStart(2, "0")} ${ampm}`;
}

const safeText = (value: unknown): string => sanitizeHtml(String(value || ""), { allowedTags: [], allowedAttributes: {} });

const CONTACT_LINE =
  "📞 01400-406374 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494";

async function sendBookingConfirmation(user: { name: string; email: string }, booking: BookedRecord): Promise<void> {
  try {
    const bookingDateFormatted = new Date(booking.bookingDate).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const testTime = convertTo12HourFormat(booking.location === "Home" ? booking.testTime : booking.startTime);
    const subject = `Confirmation: Mock Test Booking for ${bookingDateFormatted}`;
    const messageContent = `
        <div>
          <p>Dear ${safeText(user.name) || "Student"},</p>
          <p>This is a friendly reminder that your mock test is scheduled for <strong>${bookingDateFormatted}</strong>. Please find the details below:</p>
          <p><strong>Test Details:</strong></p>
          <ul>
            <li>Test Title: ${safeText(booking.name)} ${safeText(booking.testType)}</li>
            <li>Test Date: ${bookingDateFormatted}</li>
            <li>Test Time: ${testTime}</li>
            <li>Test Location: ${safeText(booking.location)}</li>
            <li>Reporting Time: 30 minutes before Test Time</li>
            <li>Office Address: Level 12, Gawsia Twin Peak, 743 Satmasjid Road, Dhanmondi 9/A, Dhaka-1205, Bangladesh.</li>
          </ul>
          <p><strong>Important Instructions:</strong></p>
          <ul>
            <li>Arrive at least 30 minutes before the test time for check-in.</li>
            <li>Bring a valid photo ID (Passport/NID) that matches the ID information provided at the time of account creation.</li>
            <li>Bring your own stationery items (pens, pencils, erasers) as they will not be provided at the test venue.</li>
          </ul>
          <p><strong>Mock Test Terms & Conditions:</strong></p>
          <ul>
            <li>Purchased or course-provided mock test(s) must be used within 6 months of the MR date.</li>
            <li>Free mock test(s) must be taken within 10 days of the MR date.</li>
            <li>Mock test rescheduling requests must be made 24 hours prior to the booked test date.</li>
            <li>Any mismatch between the provided ID details and the ID shown on the test day may result in test cancellation, and no refunds will be issued in such cases.</li>
            <li>Late arrivals, no-shows, invalid photo IDs, or expired service validity may result in forfeiting the test, with no refund requests entertained.</li>
            <li>Students are required to maintain professional behavior with Luminedge employees at all times. Any instance of misbehavior may result in service cancellation, with no refund issued.</li>
          </ul>
          <p>To facilitate a smooth check-in process, kindly present your valid photo ID (Passport/NID) voucher to our office executive upon arrival. This step is crucial to confirm your eligibility for the mock test.</p>
          <p>We sincerely appreciate your cooperation in adhering to these guidelines. Your punctuality and preparedness will contribute to a successful and efficient mock test experience.</p>
          <p>Thank you for choosing Luminedge for your test preparation needs. If you have any questions or require further assistance, please do not hesitate to contact us.</p>
          <p>${CONTACT_LINE}</p>
          <p>We wish you the best for your mock test!</p>
          <p>Best regards,</p>
          <p>The Luminedge Team</p>
        </div>
      `;
    const emailResult = await emailSender(subject, user.email, messageContent);
    logEmailOutcome(
      `Booking confirmation email to ${user.email} (primary booking operation completed successfully)`,
      emailResult
    );
  } catch (error) {
    console.error("Error sending email:", error);
  }
}

export const legacyBookingNotifier: BookingNotifier = {
  bookingConfirmed(user, booking): void {
    waitUntil(sendBookingConfirmation(user, booking));
  },

  attendanceRecorded(user, attendance, formattedDate): void {
    const safeUserName = sanitizeName(user.name || "Student");
    let subject: string;
    let messageContent: string;
    if (attendance === "present") {
      subject = "Thank You for Participating in Your Mock Test";
      messageContent = `
          <div>
            <p>Dear ${safeUserName},</p>
            <p>Thank you for attending your mock test on <strong>${formattedDate}</strong> at Luminedge! We hope the experience was helpful in assessing your preparation.</p>
            <p>Here are a few next steps to make the most of your mock test:</p>
            <ul>
              <li>Review your performance and identify improvement areas.</li>
              <li>Reach out to us if you need additional resources or support to enhance your preparation.</li>
            </ul>
            <p>Your insights help us improve our services. If you have any feedback about the test experience, feel free to share it with us at:</p>
            <p>${CONTACT_LINE}</p>
            <p>We wish you the best of luck as you continue your journey toward success!</p>
            <p>Best regards,</p>
            <p>The Luminedge Team</p>
          </div>
        `;
    } else if (attendance === "absent") {
      subject = "We Missed You at Your Mock Test";
      messageContent = `
          <div>
            <p>Dear ${safeUserName},</p>
            <p>We noticed that you couldn't attend your mock test scheduled on <strong>${formattedDate}</strong> at Luminedge! We understand that unexpected situations can arise, and we genuinely care about your preparation journey.</p>
            <p>Here are a few options to help you get back on track:</p>
            <ul>
              <li>Consider purchasing additional mock tests to continue your preparation journey.</li>
              <li>Reach out to our expert instructors for personalized guidance and strategies to enhance your test readiness.</li>
            </ul>
            <p>We're here to support you in achieving your goals. If you need assistance or have any questions, feel free to contact us at:</p>
            <p>${CONTACT_LINE}</p>
            <p>Your success is our priority, and we're committed to helping you every step of the way!</p>
            <p>Best regards,</p>
            <p>The Luminedge Team</p>
          </div>
        `;
    } else {
      return;
    }
    waitUntil(
      emailSender(subject, user.email, messageContent)
        .then((emailResult: { success: boolean; error?: unknown }) =>
          logEmailOutcome(
            `Attendance email to ${user.email} (attendance record was still updated successfully)`,
            emailResult
          )
        )
        .catch((err: unknown) => console.error("Unexpected error sending attendance email:", err))
    );
  },
};

const GRANT_CONTACT =
  "📞 **01400-403474** | **01400-403475** | **01400-403486** | **01400-403487** | **01400-403493** | **01400-403494**";

function safeMockField(value: unknown): string {
  return sanitizeHtml(String(value || ""), { allowedTags: [], allowedAttributes: {} });
}

export const legacyUserNotifier: UserNotifier = {
  mocksGranted(user, addedMocks): void {
    const emailHTML = `
    <h2>Dear ${sanitizeName(user.name)},</h2>
    <p>
      We are pleased to inform you that your mock test records have been successfully updated in our system.
      Please find your latest mock test details below:
    </p>
    ${addedMocks
      .map((mock: MockGrantEntry, i: number) => {
        return `
        <p>📝 <strong>Mock Test ${i + 1}</strong></p>
        <ul>
          <li><strong>Test Type:</strong> ${safeMockField(mock.mockType)}</li>
          <li><strong>Mode:</strong> ${safeMockField(mock.testType)}</li>
          ${mock.testSystem ? `<li><strong>Test System:</strong> ${safeMockField(mock.testSystem)}</li>` : ""}
          <li><strong>Total Number of Mocks Added:</strong> ${safeMockField(mock.mock)}</li>
          <li><strong>Updated Money Receipt (MR) Number:</strong> ${safeMockField(mock.transactionId)}</li>
          <li><strong>Service Validity:</strong> ${safeMockField(mock.mrValidation)}</li>
        </ul>
        <br/>
      `;
      })
      .join("")}
    <p>If you have any questions or need further assistance, please don't hesitate to reach out to our support team.</p>
    <p>${GRANT_CONTACT}</p>
    <p>
      Thank you for choosing <strong>Luminedge</strong>.<br/>
      We're committed to supporting your journey to success.
    </p>
    <p>Best regards,<br/><strong>The Luminedge Team</strong></p>
  `;
    waitUntil(
      emailSender("Email for Mock Test Details Update", user.email, emailHTML).then((emailResult) =>
        logEmailOutcome(`Mock test details email to ${user.email}`, emailResult)
      )
    );
  },

  accountCompleted(user): void {
    const safeName = sanitizeName(user.name) || "Student";
    const messageContent = `
              <div>
                <p>Dear ${safeName},</p>
                <p>We are excited to inform you that your account on the Luminedge Mock Booking Portal has been verified. You can now log in and book your mock tests conveniently at <a href="https://luminedge.io">luminedge.io</a>.</p>
                <h4>Important Guidelines:</h4>
                <ul>
                  <li><strong>Photo ID Requirement:</strong> You must present a valid photo ID (Passport/NID) on the day of your mock test.</li>
                  <li><strong>Mock Test Terms & Conditions:</strong></li>
                  <ul>
                    <li>Purchased or course-provided mock test(s) must be used within 6 months of the Money Receipt (MR) date.</li>
                    <li>Free mock test(s) must be taken within 10 days of the MR date.</li>
                    <li>Mock test bookings must be made at least 24 hours in advance, subject to availability.</li>
                    <li>Rescheduling is possible if requested 24 hours before the booked test date.</li>
                    <li>Late arrivals, no-shows, invalid photo IDs, or expired service validity may result in forfeiting the test, with no refund requests entertained.</li>
                  </ul>
                </ul>
                <p>We recommend booking your mock tests early to secure your preferred schedule.</p>
                <p>For any assistance, feel free to contact us at ${CONTACT_LINE}.</p>
                <p>Thank you for choosing Luminedge. We are committed to supporting your success!</p>
                <p>Best regards,</p>
                <p>The Luminedge Team</p>
              </div>
            `;
    waitUntil(
      emailSender("Your Account is Verified: Start Booking Mock Tests Now!", user.email, messageContent)
        .then((emailResult) => logEmailOutcome(`Verification email to ${user.email}`, emailResult))
        .catch((err: unknown) => console.error("Error sending verification email:", err))
    );
  },
};