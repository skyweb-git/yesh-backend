const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const FeeCycle = require('../models/FeeCycle');
const Payment = require('../models/Payment');
const User = require('../models/User');
const { requireAuth, requireRole } = require('../middleware/auth');

// Helper to resolve student User object by ID string, mongo _id, or email
async function resolveStudentUser(param) {
  if (!param || param === 'undefined' || param === 'null' || param === 'invalid') return null;
  if (mongoose.Types.ObjectId.isValid(param)) {
    const userById = await User.findById(param);
    if (userById) return userById;
  }
  const userByCode = await User.findOne({ 
    $or: [{ studentId: param }, { email: param }] 
  });
  return userByCode;
}

router.post('/cycle', requireAuth, requireRole(['admin', 'teacher']), async (req, res) => {
  try {
    const { studentId, feeAmount, feeType, cycleDays, nextDueDate } = req.body;
    const numericAmount = Number(feeAmount) || 2000;
    
    let targetStudentId = studentId;
    const studentObj = await resolveStudentUser(studentId);
    if (studentObj) {
      targetStudentId = studentObj._id;
    }

    // Deactivate previous active fee cycles for this student
    await FeeCycle.updateMany({ studentId: targetStudentId, isActive: true }, { isActive: false });

    const newCycle = new FeeCycle({
      studentId: targetStudentId,
      tutorId: req.user ? req.user._id : null,
      feeAmount: numericAmount,
      feeType: feeType || 'Monthly Tuition',
      cycleDays: Number(cycleDays) || 30,
      nextDueDate: nextDueDate || new Date()
    });
    
    await newCycle.save();

    // Auto-link parent if available & update student termFee
    let parentId = req.body.parentId || null;
    if (studentObj) {
      studentObj.termFee = `₹${numericAmount.toLocaleString('en-IN')}`;
      await studentObj.save();

      if (!parentId) {
        if (studentObj.parentId) {
          parentId = studentObj.parentId;
        } else {
          const parentObj = await User.findOne({ children: studentObj._id });
          if (parentObj) parentId = parentObj._id;
        }
      }
    } else if (mongoose.Types.ObjectId.isValid(targetStudentId)) {
      await User.findByIdAndUpdate(targetStudentId, { 
        termFee: `₹${numericAmount.toLocaleString('en-IN')}` 
      });
    }

    // Remove any previous un-paid PENDING payments and issue new pending payment matching exact admin fee
    await Payment.deleteMany({ studentId: targetStudentId, status: 'PENDING' });

    const payment = new Payment({
      feeCycleId: newCycle._id,
      studentId: newCycle.studentId,
      parentId: parentId,
      amount: numericAmount,
      dueDate: newCycle.nextDueDate,
      status: 'PENDING'
    });
    await payment.save();

    res.status(201).json(newCycle);
  } catch (error) {
    console.error('Error creating fee cycle:', error);
    res.status(500).json({ message: 'Error creating fee cycle', error: error.message });
  }
});

// Get overall revenue summary analytics (paid vs unpaid)
router.get('/summary', requireAuth, async (req, res) => {
  try {
    let totalCollected = 0;
    let totalPending = 0;
    let paidCount = 0;
    let pendingCount = 0;

    const validStudents = await User.find({
      $or: [
        { role: 'student' },
        { role: 'Student' },
        { studentId: { $exists: true, $ne: null, $ne: '' } }
      ]
    });
    
    // Key unique students by MongoDB _id
    const uniqueStudentsMap = new Map();
    validStudents.forEach(st => {
      uniqueStudentsMap.set(st._id.toString(), st);
    });
    const uniqueStudents = Array.from(uniqueStudentsMap.values());

    for (const st of uniqueStudents) {
      // Find any sibling user records sharing studentId or email with st
      const siblingUsers = await User.find({
        _id: { $ne: st._id },
        $or: [
          ...(st.studentId ? [{ studentId: st.studentId }] : []),
          ...(st.email ? [{ email: new RegExp(`^${st.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }] : [])
        ]
      });

      const matchedUserIds = [st._id, ...siblingUsers.map(u => u._id)];
      if (st.studentId && mongoose.Types.ObjectId.isValid(st.studentId)) {
        matchedUserIds.push(st.studentId);
      }

      let stPayments = await Payment.find({ studentId: { $in: matchedUserIds } }).sort({ dueDate: -1 });

      // Clean up extra premature pending invoices if any
      const pendingPayments = stPayments.filter(item => item.status === 'PENDING').sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
      if (pendingPayments.length > 1) {
        const extraPendingIds = pendingPayments.slice(1).map(item => item._id);
        await Payment.deleteMany({ _id: { $in: extraPendingIds } });
        stPayments = stPayments.filter(item => !extraPendingIds.some(id => id.equals(item._id)));
      }

      // Sum up actual real paid payments (online paid or cash confirmed)
      const realPaidPayments = stPayments.filter(p => p.status === 'PAID' && (p.isOnlinePaid || p.paymentMethod === 'ONLINE' || p.paymentMethod === 'CASH' || p.cashConfirmedBy));
      const termFeeAmt = parseFloat((st.termFee || '2000').replace(/[^0-9.]/g, '')) || 2000;
      const isStudentPaid = realPaidPayments.length > 0 || st.status === 'Paid';

      if (isStudentPaid) {
        let studentCollected = 0;
        realPaidPayments.forEach(p => {
          studentCollected += (Number(p.amount) || termFeeAmt);
        });
        if (studentCollected === 0) {
          studentCollected = termFeeAmt;
        }
        totalCollected += studentCollected;
        paidCount++;
      } else {
        const pendingPayment = stPayments.find(p => p.status === 'PENDING' || p.status === 'OVERDUE');
        const pendingAmt = pendingPayment ? (Number(pendingPayment.amount) || termFeeAmt) : termFeeAmt;
        totalPending += pendingAmt;
        pendingCount++;
      }
    }

    res.json({
      totalRevenue: totalCollected + totalPending,
      totalCollected,
      totalPending,
      paidCount,
      pendingCount,
      paymentsCount: uniqueStudents.length
    });
  } catch (error) {
    console.error('Error fetching fee summary:', error);
    res.status(500).json({ message: 'Error fetching revenue summary' });
  }
});

// Get all active fee cycles for admin overview
router.get('/cycles', requireAuth, async (req, res) => {
  try {
    // Auto-create active FeeCycle for any student who has paid payments or active term fee but no FeeCycle yet
    const studentsWithPayments = await Payment.find({ status: 'PAID' });
    for (const p of studentsWithPayments) {
      if (p.studentId) {
        const existingCycle = await FeeCycle.findOne({ studentId: p.studentId, isActive: true });
        if (!existingCycle) {
          const newCycle = new FeeCycle({
            studentId: p.studentId,
            feeAmount: p.amount || 2000,
            feeType: 'Monthly Tuition',
            cycleDays: 30,
            nextDueDate: new Date(Date.now() + 30 * 86400000),
            isActive: true
          });
          await newCycle.save();
          if (!p.feeCycleId) {
            p.feeCycleId = newCycle._id;
            await p.save();
          }
        }
      }
    }

    const cycles = await FeeCycle.find({ isActive: true }).sort({ createdAt: -1 });
    res.json(cycles);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching fee cycles' });
  }
});

// Get comprehensive status list of all students (who paid and who has not paid)
router.get('/all-status', requireAuth, async (req, res) => {
  try {
    const students = await User.find({
      $or: [
        { role: 'student' },
        { role: 'Student' },
        { studentId: { $exists: true, $ne: null, $ne: '' } }
      ]
    }).populate('parentId', 'fullName email phone');

    // Key unique students by their MongoDB _id string so every student record is preserved
    const uniqueStudentsMap = new Map();
    students.forEach(st => {
      uniqueStudentsMap.set(st._id.toString(), st);
    });
    const uniqueStudents = Array.from(uniqueStudentsMap.values());

    const result = await Promise.all(uniqueStudents.map(async (st) => {
      // Find any sibling user records sharing studentId or email with st
      const siblingUsers = await User.find({
        _id: { $ne: st._id },
        $or: [
          ...(st.studentId ? [{ studentId: st.studentId }] : []),
          ...(st.email ? [{ email: new RegExp(`^${st.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }] : [])
        ]
      });

      const matchedUserIds = [st._id, ...siblingUsers.map(u => u._id)];
      if (st.studentId && mongoose.Types.ObjectId.isValid(st.studentId)) {
        matchedUserIds.push(st.studentId);
      }

      let stPayments = await Payment.find({ studentId: { $in: matchedUserIds } }).sort({ dueDate: -1 });

      // 1. Sanitize any auto-generated PAID records that were not actually confirmed cash or online paid
      for (const p of stPayments) {
        if (p.status === 'PAID' && !p.cashConfirmedBy && !p.cashfreeOrderId) {
          p.status = 'PENDING';
          p.paymentMethod = 'NONE';
          p.paymentDate = null;
          p.transactionId = undefined;
          p.isOnlinePaid = false;
          await p.save();
          st.status = 'Unpaid';
          await User.findByIdAndUpdate(st._id, { status: 'Unpaid' });
        } else if (p.status === 'PAID' && (p.paymentMethod === 'ONLINE' || p.paymentMethod === 'CASH')) {
          p.isOnlinePaid = true;
          await p.save();
        }
      }

      // Re-fetch payments after sanitization
      stPayments = await Payment.find({ studentId: { $in: matchedUserIds } }).sort({ dueDate: -1 });

      // 2. Remove premature future PENDING invoices if current invoice is unpaid
      const pendingPayments = stPayments.filter(item => item.status === 'PENDING').sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
      if (pendingPayments.length > 1) {
        const extraPendingIds = pendingPayments.slice(1).map(item => item._id);
        await Payment.deleteMany({ _id: { $in: extraPendingIds } });
        stPayments = stPayments.filter(item => !extraPendingIds.some(id => id.equals(item._id)));
      }

      // 3. Fallback: If no payment records exist yet for this student, auto-generate an initial payment invoice
      if (stPayments.length === 0) {
        const numAmount = parseFloat((st.termFee || '2000').replace(/[^0-9.]/g, '')) || 2000;
        const initialPayment = new Payment({
          studentId: st._id,
          parentId: st.parentId ? (st.parentId._id || st.parentId) : null,
          amount: numAmount,
          status: 'PENDING',
          paymentMethod: 'NONE',
          dueDate: new Date(),
          paymentDate: null,
          transactionId: undefined,
          isOnlinePaid: false
        });
        await initialPayment.save();
        stPayments = [initialPayment];
        st.status = 'Unpaid';
        await User.findByIdAndUpdate(st._id, { status: 'Unpaid' });
      }

      const paidPayment = stPayments.find(p => p.status === 'PAID' && (p.isOnlinePaid || p.paymentMethod === 'ONLINE' || p.paymentMethod === 'CASH' || p.cashConfirmedBy));
      
      if (paidPayment) {
        const latestPaidDate = new Date(paidPayment.paymentDate || paidPayment.dueDate || Date.now());
        const obsoletePending = stPayments.filter(p => p.status === 'PENDING' && new Date(p.dueDate) <= latestPaidDate);
        if (obsoletePending.length > 0) {
          const obsIds = obsoletePending.map(p => p._id);
          await Payment.deleteMany({ _id: { $in: obsIds } });
          stPayments = stPayments.filter(p => !obsIds.some(id => id.equals(p._id)));
        }
      }

      const pendingPayment = stPayments.find(p => p.status === 'PENDING' || p.status === 'OVERDUE');

      const isPaid = (st.status === 'Paid') || Boolean(paidPayment);
      const now = new Date();
      const hasOverduePending = pendingPayment && new Date(pendingPayment.dueDate) <= now;
      const isUpToDate = isPaid && !hasOverduePending;

      const latestPayment = isPaid ? (paidPayment || stPayments[0]) : (pendingPayment || stPayments[0]);
      const nextPayment = (isPaid && pendingPayment && new Date(pendingPayment.dueDate) > now) ? pendingPayment : null;

      let parentInfo = st.parentId;
      if (!parentInfo) {
        const parentUser = await User.findOne({ children: st._id }).select('fullName email phone');
        if (parentUser) parentInfo = parentUser;
      }

      return {
        _id: st._id,
        fullName: st.fullName,
        studentId: st.studentId || 'N/A',
        email: st.email,
        courseName: st.courseName || 'General Tuition',
        termFee: st.termFee || '₹2,000',
        userStatus: st.status,
        parent: parentInfo ? {
          fullName: parentInfo.fullName,
          email: parentInfo.email,
          phone: parentInfo.phone
        } : null,
        payments: stPayments,
        latestPayment: latestPayment ? {
          _id: latestPayment._id,
          amount: latestPayment.amount,
          status: latestPayment.status,
          paymentMethod: latestPayment.paymentMethod,
          dueDate: latestPayment.dueDate,
          paymentDate: latestPayment.paymentDate,
          transactionId: latestPayment.transactionId
        } : null,
        nextDueDate: nextPayment ? nextPayment.dueDate : null,
        isPaid: isUpToDate,
        isUpToDate: isUpToDate,
        pendingPaymentId: pendingPayment ? pendingPayment._id : (latestPayment ? latestPayment._id : null)
      };
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching fee status list:', error);
    res.status(500).json({ message: 'Error fetching fee status list', error: error.message });
  }
});

// Get active fee cycles for a student
router.get('/student/:studentId', requireAuth, async (req, res) => {
  try {
    const p = req.params.studentId;
    if (!p || p === 'undefined' || p === 'null' || p === 'invalid') return res.json([]);

    const studentObj = await resolveStudentUser(p);
    const targetId = studentObj ? studentObj._id : (mongoose.Types.ObjectId.isValid(p) ? p : null);
    if (!targetId) return res.json([]);

    const cycles = await FeeCycle.find({ studentId: targetId, isActive: true });
    res.json(cycles);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching fee cycles' });
  }
});

// Get payments for a student
router.get('/payments/student/:studentId', requireAuth, async (req, res) => {
  try {
    const p = req.params.studentId;
    if (!p || p === 'undefined' || p === 'null' || p === 'invalid') return res.json([]);

    const studentObj = await resolveStudentUser(p);
    let matchedUserIds = [];
    if (studentObj) {
      const siblingUsers = await User.find({
        _id: { $ne: studentObj._id },
        $or: [
          ...(studentObj.studentId ? [{ studentId: studentObj.studentId }] : []),
          ...(studentObj.email ? [{ email: new RegExp(`^${studentObj.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }] : [])
        ]
      });
      matchedUserIds = [studentObj._id, ...siblingUsers.map(u => u._id)];
      if (studentObj.studentId && mongoose.Types.ObjectId.isValid(studentObj.studentId)) {
        matchedUserIds.push(studentObj.studentId);
      }
    } else if (mongoose.Types.ObjectId.isValid(p)) {
      matchedUserIds.push(p);
    }

    let payments = matchedUserIds.length > 0 ? await Payment.find({ studentId: { $in: matchedUserIds } }).sort({ dueDate: -1 }) : [];

    // 1. Sanitize any auto-generated PAID records that were not actually confirmed cash or online paid
    for (const item of payments) {
      if (item.status === 'PAID' && !item.cashConfirmedBy && !item.cashfreeOrderId) {
        item.status = 'PENDING';
        item.paymentMethod = 'NONE';
        item.paymentDate = null;
        item.transactionId = undefined;
        item.isOnlinePaid = false;
        await item.save();
        if (studentObj) {
          studentObj.status = 'Unpaid';
          await User.findByIdAndUpdate(studentObj._id, { status: 'Unpaid' });
        }
      } else if (item.status === 'PAID' && (item.paymentMethod === 'ONLINE' || item.paymentMethod === 'CASH')) {
        item.isOnlinePaid = true;
        await item.save();
      }
    }

    // Re-fetch payments after sanitization
    payments = matchedUserIds.length > 0 ? await Payment.find({ studentId: { $in: matchedUserIds } }).sort({ dueDate: -1 }) : [];

    // 2. Clean up premature future PENDING invoices if student already has a valid paid payment
    const paidPayment = payments.find(p => p.status === 'PAID' && (p.isOnlinePaid || p.paymentMethod === 'ONLINE' || p.paymentMethod === 'CASH' || p.cashConfirmedBy));
    if (paidPayment) {
      const latestPaidTime = new Date(paidPayment.paymentDate || paidPayment.dueDate || Date.now()).getTime();
      const prematurePending = payments.filter(p => p.status === 'PENDING' && (new Date(p.dueDate).getTime() > Date.now() || new Date(p.dueDate).getTime() > latestPaidTime));
      if (prematurePending.length > 0) {
        const pIds = prematurePending.map(p => p._id);
        await Payment.deleteMany({ _id: { $in: pIds } });
        payments = payments.filter(p => !pIds.some(id => id.equals(p._id)));
      }
    }

    // If student has multiple unpaid PENDING payments, remove any premature future ones
    const pendingPayments = payments.filter(item => item.status === 'PENDING').sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime());
    if (pendingPayments.length > 1) {
      const extraPendingIds = pendingPayments.slice(1).map(item => item._id);
      await Payment.deleteMany({ _id: { $in: extraPendingIds } });
      payments = payments.filter(item => !extraPendingIds.some(id => id.equals(item._id)));
    }

    // 3. Fallback: If no payment records exist yet for this student, auto-generate an initial payment invoice
    if (payments.length === 0 && studentObj) {
      const numAmount = parseFloat((studentObj.termFee || '2000').replace(/[^0-9.]/g, '')) || 2000;

      const initialPayment = new Payment({
        studentId: studentObj._id,
        parentId: studentObj.parentId || null,
        amount: numAmount,
        status: 'PENDING',
        paymentMethod: 'NONE',
        dueDate: new Date(),
        paymentDate: null,
        transactionId: undefined,
        isOnlinePaid: false
      });

      await initialPayment.save();
      payments = [initialPayment];
      studentObj.status = 'Unpaid';
      await User.findByIdAndUpdate(studentObj._id, { status: 'Unpaid' });
    }

    res.json(payments);
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ message: 'Error fetching payments' });
  }
});

// Confirm Cash Payment (Only Teacher/Admin)
router.post('/payments/:paymentId/confirm-cash', requireAuth, requireRole(['admin', 'teacher']), async (req, res) => {
  try {
    let payment = null;
    if (mongoose.Types.ObjectId.isValid(req.params.paymentId)) {
      payment = await Payment.findById(req.params.paymentId);
    }
    
    if (!payment) {
      payment = await Payment.findOne({ studentId: req.params.paymentId, status: 'PENDING' });
    }

    if (!payment) {
      const studentObj = await resolveStudentUser(req.params.paymentId);
      if (studentObj) {
        payment = new Payment({
          studentId: studentObj._id,
          amount: parseFloat((studentObj.termFee || '2000').replace(/[^0-9.]/g, '')) || 2000,
          status: 'PAID',
          paymentMethod: 'CASH',
          paymentDate: new Date(),
          dueDate: new Date(),
          cashConfirmedBy: req.user ? req.user._id : null
        });
        await payment.save();
        studentObj.status = 'Paid';
        await studentObj.save();
        return res.json({ message: 'Cash payment confirmed and student marked as Paid', payment });
      }
      return res.status(404).json({ message: 'Payment or Student record not found' });
    }

    payment.status = 'PAID';
    payment.paymentMethod = 'CASH';
    payment.paymentDate = new Date();
    if (req.user) payment.cashConfirmedBy = req.user._id;
    await payment.save();

    if (payment.studentId) {
      await User.findByIdAndUpdate(payment.studentId, { status: 'Paid' });
    }

    if (payment.feeCycleId) {
      const cycle = await FeeCycle.findById(payment.feeCycleId);
      if (cycle && cycle.isActive) {
        const nextDate = new Date(cycle.nextDueDate);
        nextDate.setDate(nextDate.getDate() + cycle.cycleDays);
        cycle.nextDueDate = nextDate;
        await cycle.save();
      }
    }

    res.json({ message: 'Cash payment confirmed successfully', payment });
  } catch (error) {
    res.status(500).json({ message: 'Error confirming cash payment', error: error.message });
  }
});

// Cashfree Configuration
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || '';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || '';
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'SANDBOX').toUpperCase();
const CASHFREE_BASE_URL = CASHFREE_ENV === 'PRODUCTION' 
  ? 'https://api.cashfree.com/pg' 
  : 'https://sandbox.cashfree.com/pg';

// Helper function to mark payment as successful & auto-generate next cycle
async function handleSuccessfulPayment(payment, method = 'ONLINE', isOnline = true, transactionId = null) {
  payment.status = 'PAID';
  payment.isOnlinePaid = isOnline;
  payment.paymentMethod = method;
  payment.paymentDate = new Date();
  if (transactionId) payment.transactionId = transactionId;
  await payment.save();

  if (payment.studentId) {
    await User.findByIdAndUpdate(payment.studentId, { status: 'Paid' });
  }

  // Ensure active FeeCycle exists and advance nextDueDate
  let cycle = null;
  if (payment.feeCycleId) {
    cycle = await FeeCycle.findById(payment.feeCycleId);
  }
  if (!cycle && payment.studentId) {
    cycle = await FeeCycle.findOne({ studentId: payment.studentId, isActive: true });
  }

  const nextDueDate = new Date(Date.now() + 30 * 86400000);

  if (cycle) {
    cycle.isActive = true;
    const nextDate = new Date(cycle.nextDueDate || Date.now());
    if (nextDate <= new Date()) {
      nextDate.setDate(new Date().getDate() + (cycle.cycleDays || 30));
    } else {
      nextDate.setDate(nextDate.getDate() + (cycle.cycleDays || 30));
    }
    cycle.nextDueDate = nextDate;
    await cycle.save();

    payment.feeCycleId = cycle._id;
    await payment.save();
  } else if (payment.studentId) {
    cycle = new FeeCycle({
      studentId: payment.studentId,
      tutorId: payment.tutorId || null,
      feeAmount: payment.amount || 2000,
      feeType: 'Monthly Tuition',
      cycleDays: 30,
      nextDueDate: nextDueDate,
      isActive: true
    });
    await cycle.save();

    payment.feeCycleId = cycle._id;
    await payment.save();
  }

  return payment;
}

// Create Cashfree Payment Order
router.post('/payments/:paymentId/create-cashfree-order', requireAuth, async (req, res) => {
  try {
    let payment = null;
    if (mongoose.Types.ObjectId.isValid(req.params.paymentId)) {
      payment = await Payment.findById(req.params.paymentId);
    }

    if (!payment) {
      const studentObj = (await resolveStudentUser(req.params.paymentId)) || req.user;
      if (studentObj) {
        payment = await Payment.findOne({ studentId: studentObj._id, status: 'PENDING' });
        if (!payment) {
          payment = new Payment({
            studentId: studentObj._id,
            parentId: studentObj.parentId || null,
            amount: parseFloat((studentObj.termFee || '2000').replace(/[^0-9.]/g, '')) || 2000,
            dueDate: new Date(),
            status: 'PENDING',
            paymentMethod: 'NONE'
          });
          await payment.save();
        }
      }
    }

    if (!payment) return res.status(404).json({ message: 'Payment record not found' });
    if (payment.status === 'PAID') return res.status(400).json({ message: 'Payment is already marked as PAID' });

    const student = await User.findById(payment.studentId);
    const parent = payment.parentId ? await User.findById(payment.parentId) : null;

    const rawCustomerId = (student ? student._id.toString() : payment.studentId.toString());
    const customerId = `cust_${rawCustomerId.slice(-12)}`;
    const customerName = (parent && parent.fullName) || (student && student.fullName) || 'Student Parent';
    const customerEmail = (parent && parent.email) || (student && student.email) || 'student@yashedu.com';
    
    let rawPhone = (parent && parent.phone) || (student && student.phone) || '9999999999';
    rawPhone = rawPhone.replace(/[^0-9]/g, '');
    if (rawPhone.length < 10) rawPhone = '9999999999';
    const customerPhone = rawPhone.slice(-10);

    const orderId = `order_${payment._id.toString()}_${Date.now()}`;
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const returnUrl = `${frontendUrl}/payment-status?order_id={order_id}&payment_id=${payment._id}`;

    const cfPayload = {
      order_id: orderId,
      order_amount: Number(payment.amount),
      order_currency: 'INR',
      customer_details: {
        customer_id: customerId,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone
      },
      order_meta: {
        return_url: returnUrl
      }
    };

    console.log(`Creating Cashfree order at ${CASHFREE_BASE_URL}/orders`, cfPayload);

    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      },
      body: JSON.stringify(cfPayload)
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree order creation failed:', cfData);
      return res.status(400).json({ 
        message: cfData.message || 'Failed to create Cashfree payment order',
        error: cfData 
      });
    }

    payment.cashfreeOrderId = cfData.order_id || orderId;
    payment.cashfreeSessionId = cfData.payment_session_id;
    await payment.save();

    res.json({
      paymentSessionId: cfData.payment_session_id,
      orderId: cfData.order_id || orderId,
      cfOrderId: cfData.cf_order_id,
      environment: CASHFREE_ENV
    });
  } catch (error) {
    console.error('Error creating Cashfree order:', error);
    res.status(500).json({ message: 'Internal server error while creating payment order', error: error.message });
  }
});

// Verify Cashfree Payment Order Status
router.post('/payments/verify-cashfree-order', requireAuth, async (req, res) => {
  try {
    const { orderId, paymentId } = req.body;
    if (!orderId) {
      return res.status(400).json({ message: 'orderId parameter is required' });
    }

    let payment = null;
    if (paymentId && mongoose.Types.ObjectId.isValid(paymentId)) {
      payment = await Payment.findById(paymentId);
    }
    if (!payment) {
      payment = await Payment.findOne({ cashfreeOrderId: orderId });
    }
    if (!payment) {
      const extractedId = orderId.split('_')[1];
      if (extractedId && mongoose.Types.ObjectId.isValid(extractedId)) {
        payment = await Payment.findById(extractedId);
      }
    }

    if (!payment) {
      return res.status(404).json({ message: 'Payment record not found for orderId' });
    }

    if (payment.status === 'PAID') {
      return res.json({ success: true, message: 'Payment already marked as PAID', payment });
    }

    console.log(`Verifying Cashfree order status for ${orderId} at ${CASHFREE_BASE_URL}/orders/${orderId}`);

    const cfResponse = await fetch(`${CASHFREE_BASE_URL}/orders/${encodeURIComponent(orderId)}`, {
      method: 'GET',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01'
      }
    });

    const cfData = await cfResponse.json();

    if (!cfResponse.ok) {
      console.error('Cashfree order status check failed:', cfData);
      return res.status(400).json({ message: cfData.message || 'Failed to verify Cashfree payment status', error: cfData });
    }

    const orderStatus = cfData.order_status;
    console.log(`Cashfree order status for ${orderId}:`, orderStatus);

    if (orderStatus === 'PAID') {
      const updatedPayment = await handleSuccessfulPayment(payment, 'ONLINE', true, orderId);
      return res.json({
        success: true,
        message: 'Payment verified successfully and recorded!',
        orderStatus,
        payment: updatedPayment
      });
    } else {
      return res.json({
        success: false,
        message: `Payment not completed. Status: ${orderStatus}`,
        orderStatus
      });
    }
  } catch (error) {
    console.error('Error verifying Cashfree order:', error);
    res.status(500).json({ message: 'Internal server error while verifying payment', error: error.message });
  }
});

// Fallback / Direct Online Payment Simulation
router.post('/payments/:paymentId/pay-online', requireAuth, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) return res.status(404).json({ message: 'Payment not found' });
    if (payment.status === 'PAID') return res.status(400).json({ message: 'Payment already marked as PAID' });

    const updatedPayment = await handleSuccessfulPayment(payment, 'ONLINE', true, `TXN-${Date.now()}`);
    res.json({ message: 'Online payment successful and next cycle generated', payment: updatedPayment });
  } catch (error) {
    console.error('Error paying online:', error);
    res.status(500).json({ message: 'Error processing online payment' });
  }
});

module.exports = router;
