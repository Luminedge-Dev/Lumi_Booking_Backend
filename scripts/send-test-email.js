require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { emailSender } = require("../emailSender");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--to") args.to = argv[++i];
    else if (argv[i] === "--attach") args.attach = argv[++i];
  }
  return args;
}

(async () => {
  const { to, attach } = parseArgs(process.argv.slice(2));

  if (!to) {
    console.error("Usage: node scripts/send-test-email.js --to <recipient> [--attach <path>]");
    process.exit(1);
  }

  const subject = "Luminedge SMTP test email";
  const content = `
    <div>
      <p>This is a test email sent via the Luminedge SMTP transport (Nodemailer).</p>
      <p>Sent at: ${new Date().toISOString()}</p>
    </div>
  `;

  let attachments;
  if (attach) {
    const filePath = path.resolve(attach);
    if (!fs.existsSync(filePath)) {
      console.error(`Attachment not found: ${filePath}`);
      process.exit(1);
    }
    attachments = [
      {
        filename: path.basename(filePath),
        content: fs.readFileSync(filePath),
        contentType: filePath.toLowerCase().endsWith(".pdf") ? "application/pdf" : undefined,
        contentDisposition: "attachment",
      },
    ];
  }

  console.log(`Sending test email to ${to}${attach ? ` with attachment ${attach}` : ""}...`);
  const result = await emailSender(subject, to, content, attachments);

  if (result.success) {
    console.log("Success:", result.info?.messageId || result.info);
    process.exit(0);
  } else {
    console.error("Failed:", result.error?.message || result.error);
    process.exit(1);
  }
})();
