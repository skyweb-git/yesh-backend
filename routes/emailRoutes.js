const express = require('express');
const router = express.Router();
const { verifySMTP, sendMail } = require('../config/mailer');

/**
 * @route   GET /api/email/status
 * @desc    Check SMTP configuration and connectivity
 */
router.get('/status', async (req, res) => {
  try {
    const result = await verifySMTP();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @route   POST /api/email/test
 * @desc    Send a test email to verify SMTP sending
 */
router.post('/test', async (req, res) => {
  try {
    const { to } = req.body;
    const recipient = to || process.env.ADMIN_EMAIL || process.env.SMTP_USER;

    if (!recipient) {
      return res.status(400).json({
        success: false,
        message: 'Recipient email is required (pass "to" in JSON body or set ADMIN_EMAIL in .env)'
      });
    }

    const info = await sendMail({
      to: recipient,
      subject: 'YashEdu Academy - SMTP Test Email',
      text: 'Congratulations! Your YashEdu Academy SMTP email service is configured and sending successfully.',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background: #ffffff;">
          <h2 style="color: #0B1329; margin-top: 0;">SMTP Test Successful!</h2>
          <p style="color: #475569; font-size: 14px; line-height: 1.6;">
            Your SMTP service for <strong>YashEdu Academy</strong> backend is connected and sending emails properly.
          </p>
          <div style="background: #f1f5f9; padding: 12px; border-radius: 6px; font-size: 12px; color: #334155;">
            <strong>Timestamp:</strong> ${new Date().toISOString()}<br/>
            <strong>Environment:</strong> ${process.env.NODE_ENV || 'development'}
          </div>
        </div>
      `
    });

    res.json({
      success: true,
      message: `Test email sent to ${recipient}`,
      info
    });
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send test email',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/email/send
 * @desc    Send custom email
 */
router.post('/send', async (req, res) => {
  try {
    const { to, subject, html, text, replyTo } = req.body;

    if (!to || !subject || (!html && !text)) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: to, subject, and either html or text'
      });
    }

    const info = await sendMail({ to, subject, html, text, replyTo });
    res.json({ success: true, message: 'Email sent successfully', info });
  } catch (error) {
    console.error('Email send error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
