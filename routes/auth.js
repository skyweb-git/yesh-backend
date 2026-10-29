const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET } = require('../middleware/auth');
const { sendMail } = require('../config/mailer');

// In-memory OTP storage for admin verification (email -> { otp, expiresAt, attempts })
const adminOtpStore = new Map();

/**
 * @route   POST /api/auth/admin/send-otp
 * @desc    Validate admin credentials and send a 6-digit OTP to admin email
 */
router.post('/admin/send-otp', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Verify admin credentials
    const isValidAdmin =
      (normalizedEmail === 'admin@yashedu.com' && password === 'admin123') ||
      (normalizedEmail === 'yasheduacademy@gmail.com' && password === 'admin123') ||
      (process.env.ADMIN_EMAIL && normalizedEmail === process.env.ADMIN_EMAIL.toLowerCase() && password === (process.env.ADMIN_PASSWORD || 'admin123'));

    if (!isValidAdmin) {
      return res.status(401).json({ success: false, message: 'Invalid administrator email or password.' });
    }

    // Generate 6-digit numeric OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

    adminOtpStore.set(normalizedEmail, { otp, expiresAt, attempts: 0 });

    // Send OTP to admin's inbox (yasheduacademy@gmail.com)
    const recipientEmail =
      normalizedEmail === 'admin@yashedu.com' && process.env.ADMIN_EMAIL
        ? process.env.ADMIN_EMAIL
        : normalizedEmail;

    // Send OTP via SMTP
    const mailResult = await sendMail({
      to: recipientEmail,
      subject: `YashEdu Admin Verification Code: ${otp}`,
      text: `Your YashEdu Admin login verification code is: ${otp}\n\nThis code will expire in 5 minutes. If you did not request this login, please change your administrator password immediately.`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 500px; margin: 0 auto; background: #0B1329; border: 1px solid #1e293b; border-radius: 16px; padding: 32px 24px; color: #f8fafc; text-align: center;">
          <div style="display: inline-block; width: 56px; height: 56px; border-radius: 14px; background: linear-gradient(135deg, #dc2626 0%, #e11d48 100%); line-height: 56px; font-size: 24px; margin-bottom: 16px;">
            🛡️
          </div>
          <h2 style="margin: 0 0 8px; font-size: 22px; font-weight: 800; color: #ffffff;">Two-Factor Verification</h2>
          <p style="margin: 0 0 24px; font-size: 13px; color: #94a3b8;">Administrator Portal Access Security</p>
          
          <div style="background: #111e38; border: 1px solid #1e293b; border-radius: 12px; padding: 24px 16px; margin-bottom: 24px;">
            <span style="font-size: 11px; font-weight: 700; color: #ef4444; text-transform: uppercase; letter-spacing: 1.5px; display: block; margin-bottom: 8px;">One-Time Passcode</span>
            <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #ffffff; font-family: 'Courier New', monospace;">
              ${otp}
            </div>
            <p style="margin: 12px 0 0; font-size: 12px; color: #64748b;">Valid for the next 5 minutes</p>
          </div>

          <p style="font-size: 12px; line-height: 1.5; color: #64748b; margin: 0 0 20px;">
            If you did not attempt to sign in to the YashEdu Administrator Portal, someone may have entered your credentials. Please secure your account immediately.
          </p>

          <div style="border-top: 1px solid #1e293b; padding-top: 16px; font-size: 11px; color: #475569;">
            © ${new Date().getFullYear()} YashEdu Academy Admin Security System.
          </div>
        </div>
      `
    });

    console.log(`[Admin OTP] Code generated for ${normalizedEmail}: ${otp}`);

    res.json({
      success: true,
      message: 'Verification code sent to your email.',
      previewOtp: mailResult?.mocked ? otp : undefined
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({ success: false, message: 'Failed to send OTP verification code.' });
  }
});

/**
 * @route   POST /api/auth/admin/verify-otp
 * @desc    Verify admin OTP and issue JWT admin session
 */
router.post('/admin/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: 'Email and OTP code are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const stored = adminOtpStore.get(normalizedEmail);

    if (!stored) {
      return res.status(400).json({ success: false, message: 'No active OTP found. Please request a new code.' });
    }

    if (Date.now() > stored.expiresAt) {
      adminOtpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: 'OTP code has expired. Please request a new one.' });
    }

    if (stored.attempts >= 5) {
      adminOtpStore.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new code.' });
    }

    if (stored.otp !== otp.toString().trim()) {
      stored.attempts += 1;
      return res.status(400).json({ success: false, message: 'Invalid OTP code. Please try again.' });
    }

    // OTP is valid! Remove from store
    adminOtpStore.delete(normalizedEmail);

    // Find or create admin user in database
    let user = await User.findOne({ email: normalizedEmail, role: 'admin' });
    if (!user) {
      user = new User({
        email: normalizedEmail,
        role: 'admin',
        firebaseUid: `admin-${Date.now()}`,
        fullName: 'System Administrator'
      });
      await user.save();
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Authentication successful',
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        fullName: user.fullName || 'System Administrator'
      }
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ success: false, message: 'Internal server error verifying OTP.' });
  }
});

// This endpoint is called by the frontend after a successful Firebase login
router.post('/login', async (req, res) => {
  try {
    const { email, role, firebaseUid, fullName } = req.body;
    
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userRole = role || 'student';
    
    // Find or create the user
    let user = await User.findOne({ email, role: userRole });
    if (!user) {
      user = await User.findOne({ email });
    }
    
    if (!user) {
      let uidToUse = firebaseUid || `temp-${Date.now()}`;
      const existingUidUser = await User.findOne({ firebaseUid: uidToUse });
      if (existingUidUser) {
        uidToUse = `${uidToUse}-${userRole}-${Date.now()}`;
      }
      user = new User({
        email,
        role: userRole,
        firebaseUid: uidToUse,
        fullName: fullName || email.split('@')[0],
      });
      await user.save();
    }

    // Generate JWT
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
        fullName: user.fullName
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Internal server error during login' });
  }
});

module.exports = router;
