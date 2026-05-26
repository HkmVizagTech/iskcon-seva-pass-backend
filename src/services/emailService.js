const nodemailer = require("nodemailer");

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async sendQRPass(to, qrImage, holderName, eventName, passDetails) {
    const mailOptions = {
      from: `"ISKCON Seva Pass" <${process.env.SMTP_FROM}>`,
      to,
      subject: `Your ISKCON Seva Pass for ${eventName}`,
      html: this.generateEmailTemplate(
        holderName,
        eventName,
        passDetails,
        qrImage,
      ),
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error("Email send error:", error);
      throw new Error("Failed to send email");
    }
  }

  generateEmailTemplate(holderName, eventName, passDetails, qrImage) {
    const entries = (passDetails.entryPoints || [])
      .map((ep) => `<li>${ep}</li>`)
      .join("");

    // FIX: format dates in IST, not raw ISO strings
    const istOpts = { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true };
    const fmtDate = (d) => {
      try { return new Date(d).toLocaleString("en-IN", istOpts); } catch { return d || ""; }
    };
    const validFromStr = fmtDate(passDetails.validFrom);
    const validUntilStr = fmtDate(passDetails.validUntil);

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                   color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
          .qr-container { text-align: center; margin: 30px 0; }
          .qr-image { max-width: 300px; border: 3px solid #ddd; border-radius: 10px; }
          .details { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
          .footer { text-align: center; margin-top: 30px; color: #666; font-size: 14px; }
          .btn { display: inline-block; padding: 12px 24px; background: #667eea;
                color: white; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🕉️ ISKCON Seva Pass</h1>
            <p>Hare Krishna! Your pass is ready</p>
          </div>
          <div class="content">
            <h2>Dear ${holderName},</h2>
            <p>Your pass for <strong>${eventName}</strong> has been generated successfully.</p>

            <div class="qr-container">
              <img src="${qrImage}" alt="QR Code" class="qr-image">
            </div>

            <div class="details">
              <h3>Pass Details:</h3>
              <ul>${entries}</ul>
              <p><strong>Valid:</strong> ${validFromStr} to ${validUntilStr}</p>
            </div>

            <p>Please show this QR code at the respective entry points during the event.</p>

            <div style="text-align: center;">
              <a href="#" class="btn">Download Pass</a>
            </div>
          </div>
          <div class="footer">
            <p>ISKCON Visakhapatnam | Hare Krishna Movement</p>
            <p>For assistance, contact: support@iskconvizag.org</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new EmailService();
