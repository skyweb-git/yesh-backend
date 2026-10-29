const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const nodemailer = require('nodemailer');

let cachedTransporter = null;

/**
 * Get or create the Nodemailer transporter instance.
 */
function getTransporter() {
  if (cachedTransporter) {
    return cachedTransporter;
  }

  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const rawPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;
  const pass = rawPass ? rawPass.trim().replace(/\s+/g, '') : '';
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = parseInt(process.env.SMTP_PORT || process.env.EMAIL_PORT || '587', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const service = process.env.SMTP_SERVICE || (host && host.includes('gmail') ? 'gmail' : undefined);

  if (!user || !pass) {
    console.warn('[SMTP] Warning: SMTP_USER or SMTP_PASS not set in environment. Outgoing emails will be mocked in console.');
    return null;
  }

  const transportConfig = service
    ? {
        service,
        auth: { user, pass }
      }
    : {
        host: host || 'smtp.gmail.com',
        port,
        secure,
        auth: { user, pass },
        tls: {
          rejectUnauthorized: false
        }
      };

  cachedTransporter = nodemailer.createTransport(transportConfig);
  return cachedTransporter;
}

/**
 * Verify SMTP connection configuration.
 */
async function verifySMTP() {
  const transporter = getTransporter();
  if (!transporter) {
    return {
      success: false,
      configured: false,
      message: 'SMTP credentials (SMTP_USER / SMTP_PASS) not configured in environment.'
    };
  }

  try {
    await transporter.verify();
    console.log('[SMTP] Connection verified successfully.');
    return {
      success: true,
      configured: true,
      message: 'SMTP connection verified successfully.'
    };
  } catch (error) {
    console.error('[SMTP] Verification failed:', error.message);
    return {
      success: false,
      configured: true,
      message: error.message
    };
  }
}

/**
 * Core sendMail function.
 * @param {Object} options
 * @param {string|string[]} options.to
 * @param {string} options.subject
 * @param {string} [options.text]
 * @param {string} [options.html]
 * @param {string} [options.from]
 * @param {string} [options.replyTo]
 * @param {Array} [options.attachments]
 */
async function sendMail({ to, subject, text, html, from, replyTo, attachments, cc, bcc }) {
  const defaultFrom =
    process.env.SMTP_FROM ||
    process.env.EMAIL_FROM ||
    `"YashEdu Academy" <${process.env.SMTP_USER || 'admissions@yasheduacademy.com'}>`;

  const mailOptions = {
    from: from || defaultFrom,
    to,
    subject,
    text,
    html,
    replyTo: replyTo || process.env.SMTP_USER,
    attachments,
    cc,
    bcc
  };

  const transporter = getTransporter();

  // If no SMTP credentials provided, log the email so development isn't blocked
  if (!transporter) {
    console.log('\n=================== [MOCKED EMAIL] ===================');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`From: ${mailOptions.from}`);
    console.log(`Body (Text): ${text || '(HTML provided)'}`);
    console.log('=======================================================\n');
    return {
      mocked: true,
      message: 'Email mocked in console. Set SMTP_USER and SMTP_PASS in .env to send real emails.',
      messageId: `mocked-${Date.now()}`
    };
  }

  const info = await transporter.sendMail(mailOptions);
  console.log(`[SMTP] Email sent to: ${to} | Message ID: ${info.messageId}`);
  return info;
}

/**
 * Send an email notification to the Admin when a user submits the Contact Form.
 */
async function sendContactAdminNotification(contactData) {
  const adminEmail = process.env.ADMIN_EMAIL || process.env.SMTP_USER || 'yasheduacademy@gmail.com';
  const { firstName, lastName, email, phone, subject, message } = contactData;
  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'Website Visitor';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>New Contact Inquiry - YashEdu Academy</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; }
          .header { background: linear-gradient(135deg, #0B1329 0%, #1e293b 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
          .header p { margin: 6px 0 0; font-size: 13px; color: #94a3b8; text-transform: uppercase; letter-spacing: 1px; }
          .content { padding: 32px 24px; }
          .badge { display: inline-block; background-color: #fee2e2; color: #dc2626; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 20px; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
          .info-table td { padding: 12px 14px; font-size: 14px; border-bottom: 1px solid #f1f5f9; }
          .info-table td.label { font-weight: 700; color: #64748b; width: 35%; background: #f8fafc; border-radius: 6px 0 0 6px; }
          .info-table td.value { color: #0f172a; font-weight: 600; }
          .message-box { background: #f8fafc; border-left: 4px solid #dc2626; padding: 16px; border-radius: 0 8px 8px 0; font-size: 14px; line-height: 1.6; color: #334155; margin-bottom: 28px; white-space: pre-wrap; }
          .btn-container { text-align: center; margin-bottom: 24px; }
          .btn { display: inline-block; background: #dc2626; color: #ffffff !important; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 700; font-size: 14px; }
          .footer { background: #f8fafc; padding: 20px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>YashEdu Academy</h1>
            <p>New Student / Parent Inquiry</p>
          </div>
          <div class="content">
            <span class="badge">New Contact Submission</span>
            <table class="info-table">
              <tr>
                <td class="label">Full Name</td>
                <td class="value">${fullName}</td>
              </tr>
              <tr>
                <td class="label">Email Address</td>
                <td class="value"><a href="mailto:${email}" style="color: #dc2626; text-decoration: none;">${email}</a></td>
              </tr>
              <tr>
                <td class="label">Phone / WhatsApp</td>
                <td class="value">${phone ? `<a href="tel:${phone}" style="color: #0f172a; text-decoration: none;">${phone}</a>` : 'Not Provided'}</td>
              </tr>
              <tr>
                <td class="label">Subject</td>
                <td class="value">${subject || 'General Inquiry'}</td>
              </tr>
              <tr>
                <td class="label">Date & Time</td>
                <td class="value">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</td>
              </tr>
            </table>

            <div style="font-weight: 700; font-size: 13px; color: #64748b; margin-bottom: 8px; text-transform: uppercase;">Message Content:</div>
            <div class="message-box">${message}</div>

            <div class="btn-container">
              <a href="mailto:${email}?subject=Re: ${encodeURIComponent(subject || 'Inquiry at YashEdu Academy')}" class="btn">Reply via Email</a>
            </div>
          </div>
          <div class="footer">
            © ${new Date().getFullYear()} YashEdu Academy. This is an automated notification from your website.
          </div>
        </div>
      </body>
    </html>
  `;

  return sendMail({
    to: adminEmail,
    replyTo: email,
    subject: `[Contact Form] ${subject || 'New Inquiry'} - ${fullName}`,
    text: `New inquiry from ${fullName} (${email}, Phone: ${phone || 'N/A'}):\n\nSubject: ${subject}\n\nMessage:\n${message}`,
    html
  });
}

/**
 * Send an automated confirmation acknowledgment email to the user.
 */
async function sendContactUserConfirmation(contactData) {
  const { firstName, lastName, email, subject } = contactData;
  const fullName = `${firstName || ''} ${lastName || ''}`.trim() || 'Student / Parent';

  if (!email) return null;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Thank You for Contacting YashEdu Academy</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f6f9; margin: 0; padding: 20px; color: #333; }
          .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 20px rgba(0,0,0,0.08); border: 1px solid #e5e7eb; }
          .header { background: linear-gradient(135deg, #0B1329 0%, #1e293b 100%); padding: 32px 24px; text-align: center; color: #ffffff; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 800; }
          .header p { margin: 6px 0 0; font-size: 13px; color: #94a3b8; letter-spacing: 1px; text-transform: uppercase; }
          .content { padding: 32px 24px; line-height: 1.6; color: #334155; }
          .highlight { background: #fee2e2; color: #dc2626; padding: 2px 8px; border-radius: 4px; font-weight: 700; }
          .contact-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 18px; margin: 24px 0; }
          .contact-card h4 { margin: 0 0 10px; font-size: 14px; font-weight: 700; color: #0f172a; text-transform: uppercase; }
          .contact-card p { margin: 4px 0; font-size: 13px; color: #64748b; }
          .footer { background: #f8fafc; padding: 20px 24px; text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>YashEdu Academy</h1>
            <p>Learn Without Limits</p>
          </div>
          <div class="content">
            <h2 style="margin-top:0; color:#0f172a; font-size: 18px;">Hello ${fullName},</h2>
            <p>Thank you for reaching out to <strong>YashEdu Academy</strong> regarding <em>"${subject || 'your inquiry'}"</em>.</p>
            <p>We have successfully received your message. Our academic counselors and admissions team are reviewing your request and will get back to you within <strong>24 business hours</strong>.</p>
            
            <div class="contact-card">
              <h4>Need Immediate Assistance?</h4>
              <p>📞 <strong>Phone / WhatsApp:</strong> +91 86864 56117</p>
              <p>✉️ <strong>Admissions Email:</strong> admissions@yasheduacademy.com</p>
              <p>📍 <strong>Main Office:</strong> 1-4-879/86, Street No. 8, Gandhinagar, Secunderabad, Telangana 500080</p>
              <p>📍 <strong>Chilkanagar Branch:</strong> Road No. 2, MCDOWELLS COLONY, Boduppal, Hyderabad, Telangana 500039</p>
            </div>

            <p style="margin-bottom: 0;">Warm regards,<br/><strong>Admissions Team</strong><br/>YashEdu Academy</p>
          </div>
          <div class="footer">
            © ${new Date().getFullYear()} YashEdu Academy. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  return sendMail({
    to: email,
    subject: `We've received your inquiry - YashEdu Academy`,
    text: `Hello ${fullName},\n\nThank you for reaching out to YashEdu Academy regarding "${subject || 'your inquiry'}". Our team will contact you shortly.\n\nPhone: +91 86864 56117\nEmail: admissions@yasheduacademy.com`,
    html
  });
}

module.exports = {
  getTransporter,
  verifySMTP,
  sendMail,
  sendContactAdminNotification,
  sendContactUserConfirmation
};
