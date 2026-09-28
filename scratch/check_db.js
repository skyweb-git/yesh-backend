require('dotenv').config();
const mongoose = require('mongoose');

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

async function check() {
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
  const Payment = mongoose.model('Payment', new mongoose.Schema({}, { strict: false }));
  const FeeCycle = mongoose.model('FeeCycle', new mongoose.Schema({}, { strict: false }));

  const users = await User.find({
    $or: [
      { email: /vamshi/i },
      { fullName: /balcky/i },
      { studentId: /9505/i },
      { email: /abbu/i }
    ]
  });

  console.log('\n--- USERS MATCHED ---');
  console.log(users.map(u => ({ _id: u._id, fullName: u.fullName, email: u.email, studentId: u.studentId, parentId: u.parentId, status: u.status, createdAt: u.createdAt })));

  const payments = await Payment.find({});
  console.log('\n--- ALL PAYMENTS IN DB (' + payments.length + ') ---');
  payments.forEach(p => {
    console.log({
      _id: p._id,
      studentId: p.studentId,
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      isOnlinePaid: p.isOnlinePaid,
      transactionId: p.transactionId,
      paymentDate: p.paymentDate,
      dueDate: p.dueDate
    });
  });

  process.exit(0);
}

check().catch(err => {
  console.error(err);
  process.exit(1);
});
