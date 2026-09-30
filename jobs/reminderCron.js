const cron = require("node-cron");
const { differenceInDays, parseISO } = require("date-fns");
const sanitizeHtml = require("sanitize-html");
const { emailSender } = require("../emailSender");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startReminderCron(usersCollection) {
  cron.schedule(
    "00 10 * * *",
    async () => {
      console.log("⏰ Started reminder check for mock expiries...");

      try {
        const today = new Date();
        const sevenDaysFromNow = new Date(today.getTime() + 7 * 24 * 3600 * 1000);

        const users = await usersCollection.find({
          mocks: {
            $elemMatch: {
              emailReminderSent: { $ne: true },
              mrValidationExpiry: {
                $gte: today.toISOString(),
                $lte: sevenDaysFromNow.toISOString(),
              },
            },
          },
        }).toArray();

        console.log(`⏰ ${users.length} user(s) with expiring mocks to process.`);

        const bulkOps = [];

        for (const user of users) {
          try {
            if (!Array.isArray(user.mocks) || user.mocks.length === 0) continue;

            const expiringMocks = user.mocks.filter((mock) => {
              if (!mock.mrValidationExpiry) return false;
              let expiryDate;
              try {
                expiryDate = parseISO(mock.mrValidationExpiry);
                if (isNaN(expiryDate)) return false;
              } catch {
                console.warn(`⚠️ Invalid expiry date for ${user.email}`);
                return false;
              }
              const daysDiff = differenceInDays(expiryDate, today);
              return !mock.emailReminderSent && daysDiff >= 0 && daysDiff <= 7;
            });

            if (expiringMocks.length === 0) continue;

            const soonestMock = expiringMocks.reduce(
              (min, mock) =>
                parseISO(mock.mrValidationExpiry) < parseISO(min.mrValidationExpiry)
                  ? mock
                  : min,
              expiringMocks[0]
            );

            const soonestExpiryDate = new Date(
              soonestMock.mrValidationExpiry
            ).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric",
            });

            const subject = "Mock Test Booking Validity Expiring Soon";
            const message = `
        <div style="font-family: Arial, sans-serif; color: #000; font-size: 15px; line-height: 1.6;">
          <h2>Mock Test Booking Validity Expiring Soon</h2>
          <p>Dear ${sanitizeHtml(user.name || "Candidate", { allowedTags: [], allowedAttributes: {} })},</p>
          <p>This is a friendly reminder that your <strong>mock test booking</strong> on the Luminedge portal is <strong>about to expire</strong>.</p>
          <p>To avoid any disruption in your preparation:</p>
          <ul>
            <li>Complete your mock test before <strong>${soonestExpiryDate}</strong>.</li>
            <li>Contact us if you need any help.</li>
          </ul>
          ${expiringMocks
            .map((mock, index) => `
              <p>
                <strong>Expiry Date:</strong> ${new Date(mock.mrValidationExpiry).toLocaleString("en-US", {
                  year: "numeric", month: "long", day: "numeric",
                  hour: "numeric", minute: "numeric", hour12: true,
                })}<br/>
                <strong>Mock Test:</strong> ${sanitizeHtml(mock.mockType || "N/A", { allowedTags: [], allowedAttributes: {} })} (${sanitizeHtml(mock.testType || "N/A", { allowedTags: [], allowedAttributes: {} })}) / Purchased Mock ${index + 1}
              </p>
            `)
            .join("")}
          <p>Best regards,<br/><strong>Team Luminedge</strong></p>
          <p style="color: #555;">
            📞 01400-403474 | 01400-403475 | 01400-403486 | 01400-403487 | 01400-403493 | 01400-403494
          </p>
        </div>
      `;

            const result = await emailSender(subject, user.email, message);
            await delay(300);

            if (!result.success) {
              console.error(`❌ Failed to send reminder to ${user.email}: ${result.error?.message || result.error}`);
              continue;
            }

            console.log(`✅ Reminder sent to ${user.email} (${expiringMocks.length} mock(s))`);

            const expiringIds = expiringMocks.map((m) => m.transactionId);
            const now = new Date();

            // Surgically update only the matching mocks using arrayFilters
            bulkOps.push({
              updateOne: {
                filter: { email: user.email },
                update: {
                  $set: {
                    "mocks.$[elem].emailReminderSent": true,
                    "mocks.$[elem].updatedAt": now,
                    updatedAt: now,
                  },
                },
                arrayFilters: [{ "elem.transactionId": { $in: expiringIds } }],
              },
            });
          } catch (userError) {
            console.error(`❌ Error processing ${user.email}:`, userError.message);
          }
        }

        if (bulkOps.length > 0) {
          const bulkResult = await usersCollection.bulkWrite(bulkOps, { ordered: false });
          console.log(`✅ Bulk updated reminder flags for ${bulkResult.modifiedCount} user(s).`);
        }
      } catch (err) {
        console.error("❌ Cron job error:", err.message, err.stack);
      }
    },
    { timezone: "Asia/Dhaka" }
  );
}

module.exports = { startReminderCron };
