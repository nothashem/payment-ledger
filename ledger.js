// Required modules
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const axios = require('axios'); // Ensure axios is imported

const router = express.Router();  

// Default configuration
const defaultConfig = {
  "accounts": {
    "cash": {
      "USD": {
        "account_name": "Cash - USD",
        "account_type": "Asset",
        "nature": "Debit",
        "currency": "USD"
      },
      "EUR": {
        "account_name": "Cash - EUR",
        "account_type": "Asset",
        "nature": "Debit",
        "currency": "EUR"
      },
      "GBP": {
        "account_name": "Cash - GBP",
        "account_type": "Asset",
        "nature": "Debit",
        "currency": "GBP"
      }
    },
    "revenue": {
      "transaction_fees": {
        "account_name": "Transaction Fee Revenue",
        "account_type": "Revenue",
        "nature": "Credit",
        "currency": "USD"
      },
      "fx_fees": {
        "account_name": "FX Fee Revenue",
        "account_type": "Revenue",
        "nature": "Credit",
        "currency": "USD"
      }
    },
    "expense": {
      "payment_processing": {
        "account_name": "Payment Processing Expense",
        "account_type": "Expense",
        "nature": "Debit",
        "currency": "USD"
      }
    }
  },
  "fx_fees": {
    "USD": {
      "EUR": 0.01,
      "GBP": 0.01
    },
    "EUR": {
      "USD": 0.01,
      "GBP": 0.01
    },
    "GBP": {
      "USD": 0.01,
      "EUR": 0.01
    }
  },
  "transaction_fee_percentage": 0.029,
  "transaction_fee_fixed": {
    "USD": 0.30,
    "EUR": 0.25,
    "GBP": 0.20
  },
  "exchange_rates": {
    "base": "USD",
    "rates": {
      "EUR": 0.92,
      "GBP": 0.79,
      "USD": 1
    }
  },
  "payment_processing": {
    "expense_percentage": 0.3
  }
};

// Load the ledger configuration
const configPath = path.join(__dirname, 'config', 'ledgerConfig.json');
let ledgerConfig;

try {
  console.log('Attempting to load configuration from:', configPath);
  const rawConfig = fs.readFileSync(configPath);
  ledgerConfig = JSON.parse(rawConfig);
  console.log('Configuration loaded successfully');
} catch (error) {
  console.warn('Error loading ledger configuration:', error.message);
  console.log('Using default configuration');
  ledgerConfig = defaultConfig;
}

// Log the current working directory and file structure
console.log('Current working directory:', process.cwd());
console.log('Directory contents:', fs.readdirSync(process.cwd()));

const accountSchema = new mongoose.Schema({
  account_id: { type: String, default: uuidv4, unique: true },
  account_number: { type: String, required: true },
  account_name: { type: String, required: true },
  account_type: {
    type: String,
    required: true,
    enum: ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense'],
  },
  parent_account_id: { type: String, ref: 'Account' },
  currency: { type: String, required: true },
  status: { type: String, required: true, enum: ['Active', 'Inactive', 'Closed'] },
  nature: { type: String, required: true, enum: ['Debit', 'Credit'] },
  balance: { type: Number, required: true, default: 0 },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  metadata: { type: mongoose.Schema.Types.Mixed },
});

const Account = mongoose.model('Account', accountSchema);

// ==========================
// Ledger Entry Schema and Model
// ==========================
const ledgerEntrySchema = new mongoose.Schema({
  entry_id: { type: String, default: uuidv4, unique: true },
  entryGroupId: { type: String, required: true },
  transaction_id: { type: String },
  event_id: { type: String },
  account_id: { type: String, required: true },
  entry_type: { type: String, required: true, enum: ['Debit', 'Credit'] },
  amount: { type: Number, required: true },
  currency: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  description: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  isReversal: { type: Boolean, default: false },
  isReversed: { type: Boolean, default: false },
  originalEntryId: { type: String }, 
});

const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);

// ==========================
// Helper Functions
// ==========================

async function updateAccountBalance(accountId, entryType, amount, currency) {
  const account = await Account.findOne({ account_id: accountId });
  if (!account) {
    throw new Error(`Account with ID ${accountId} not found`);
  }

  if (account.currency !== currency) {
    throw new Error(`Currency mismatch: Account currency (${account.currency}) does not match entry currency (${currency})`);
  }

  // Update balance based on account nature and entry type
  let balanceChange = amount;
  if (account.nature === 'Debit') {
    balanceChange = entryType === 'Debit' ? amount : -amount;
  } else if (account.nature === 'Credit') {
    balanceChange = entryType === 'Credit' ? amount : -amount;
  }

  account.balance += balanceChange;
  await account.save();
}

// Helper function to find or create an account
async function findOrCreateAccount(accountCriteria) {
  // Check if the account exists in the configuration
  const configAccount = ledgerConfig.accounts[accountCriteria.account_type.toLowerCase()]?.[accountCriteria.currency];
  
  if (configAccount) {
    accountCriteria = { ...configAccount, ...accountCriteria };
  }

  let account = await Account.findOne({
    account_name: accountCriteria.account_name,
    currency: accountCriteria.currency,
  });

  if (!account) {
    // Create the account using the configuration or provided criteria
    const uniqueId = uuidv4();
    account = new Account({
      account_id: uniqueId,
      account_number: uniqueId,
      ...accountCriteria,
      balance: 0,
      status: 'Active',
      metadata: accountCriteria.metadata || {},
    });

    await account.save();
  }

  return account;
}

function getExchangeRate(fromCurrency, toCurrency) {
  const { base, rates } = ledgerConfig.exchange_rates;
  
  if (fromCurrency === toCurrency) {
    return 1;
  }
  
  if (!rates[fromCurrency] || !rates[toCurrency]) {
    throw new Error(`Exchange rate not available for ${fromCurrency} to ${toCurrency}`);
  }
  
  // Calculate the exchange rate
  return rates[toCurrency] / rates[fromCurrency];
}

function convertCurrency(amount, fromCurrency, toCurrency) {
  const rate = getExchangeRate(fromCurrency, toCurrency);
  return amount * rate;
}

async function executeActions(eventType, payload) {
  const entryGroupId = uuidv4();
  const ledgerEntries = [];
  const transactionId = payload.transaction_id || uuidv4();
  const eventId = payload.event_id || uuidv4();

  let totalDebits = 0;
  let totalCredits = 0;

  console.log(`Processing ${eventType} event with payload:`, JSON.stringify(payload, null, 2));

  switch (eventType) {
    case 'PaymentCaptured':
      const { amount, currency, merchantId, transactionFee } = payload;
      
      if (!amount || !currency || !merchantId || transactionFee === undefined) {
        throw new Error('Missing required fields in payload for PaymentCaptured');
      }

      const sourceCurrency = currency;
      const settlementCurrency = payload.settlementCurrency || sourceCurrency;

      let totalAmountInSettlementCurrency = amount;
      let transactionFeeInSettlementCurrency = transactionFee;
      let fxFee = 0;
      let exchangeRate = 1;

      // Perform currency conversion if needed
      if (sourceCurrency !== settlementCurrency) {
        exchangeRate = getExchangeRate(sourceCurrency, settlementCurrency);
        totalAmountInSettlementCurrency = amount * exchangeRate;
        transactionFeeInSettlementCurrency = transactionFee * exchangeRate;
        
        // Calculate FX fee
        const fxFeeRate = ledgerConfig.fx_fees[sourceCurrency]?.[settlementCurrency] || 0;
        fxFee = amount * fxFeeRate * exchangeRate;
      }

      // Create ledger entries
      ledgerEntries.push(
        // Debit Cash (in settlement currency)
        {
          account_id: (await findOrCreateAccount({
            account_name: `Cash - ${settlementCurrency}`,
            currency: settlementCurrency,
            account_type: 'Asset',
            nature: 'Debit',
          })).account_id,
          entry_type: 'Debit',
          amount: totalAmountInSettlementCurrency,
          currency: settlementCurrency,
          description: `Funds received from customer ${payload.customerId || ''}`,
        }
      );
      totalDebits += totalAmountInSettlementCurrency;

      // Credit Merchant Payable
      ledgerEntries.push({
        account_id: (await findOrCreateAccount({
          account_name: `Merchant Payable - ${merchantId}`,
          currency: settlementCurrency,
          account_type: 'Liability',
          nature: 'Credit',
        })).account_id,
        entry_type: 'Credit',
        amount: totalAmountInSettlementCurrency - transactionFeeInSettlementCurrency - fxFee,
        currency: settlementCurrency,
        description: `Liability to pay the merchant ${merchantId}`,
      });
      totalCredits += totalAmountInSettlementCurrency - transactionFeeInSettlementCurrency - fxFee;

      // Credit Transaction Fee Revenue
      ledgerEntries.push({
        account_id: (await findOrCreateAccount({
          ...ledgerConfig.accounts.revenue.transaction_fees,
          currency: settlementCurrency
        })).account_id,
        entry_type: 'Credit',
        amount: transactionFeeInSettlementCurrency,
        currency: settlementCurrency,
        description: 'Transaction fee revenue',
      });
      totalCredits += transactionFeeInSettlementCurrency;

      // Add FX fee entry if applicable
      if (fxFee > 0) {
        ledgerEntries.push({
          account_id: (await findOrCreateAccount({
            ...ledgerConfig.accounts.revenue.fx_fees,
            currency: settlementCurrency
          })).account_id,
          entry_type: 'Credit',
          amount: fxFee,
          currency: settlementCurrency,
          description: 'FX fee revenue',
        });
        totalCredits += fxFee;
      }

      console.log('Ledger entries:', JSON.stringify(ledgerEntries, null, 2));
      console.log(`Total Debits: ${totalDebits.toFixed(2)}, Total Credits: ${totalCredits.toFixed(2)}`);

      // Ensure balance
      if (Math.abs(totalDebits - totalCredits) > 0.001) {
        throw new Error(`Ledger entries are not balanced. Debits: ${totalDebits.toFixed(2)}, Credits: ${totalCredits.toFixed(2)}`);
      }

      break;

    case 'PaymentRefunded':
      // Ensure required fields are present
      if (!payload.amount || !payload.currency || !payload.merchantId) {
        throw new Error('Missing required fields in payload for PaymentRefunded');
      }

      // Fetch necessary accounts
      const merchantPayableAccountRefund = await findOrCreateAccount({
        account_name: `Merchant Payable - ${payload.merchantId}`,
        currency: payload.currency,
        account_type: 'Liability',
        nature: 'Credit',
      });

      // Check if merchant has sufficient funds
      if (merchantPayableAccountRefund.balance < payload.amount) {
        throw new Error('Insufficient funds in merchant account for refund');
      }

      const cashAccountRefund = await findOrCreateAccount({
        account_name: `Cash - ${payload.currency}`,
        currency: payload.currency,
        account_type: 'Asset',
        nature: 'Debit',
      });

      // Create ledger entries
      ledgerEntries.push(
        // Debit Merchant Payable (Liability decrease)
        {
          account_id: merchantPayableAccountRefund.account_id,
          entry_type: 'Debit',
          amount: payload.amount,
          currency: payload.currency,
          description: `Refund to customer for merchant ${payload.merchantId}`,
          metadata: { ...payload.metadata, refundType: 'Full' }
        },
        // Credit Cash (Asset decrease)
        {
          account_id: cashAccountRefund.account_id,
          entry_type: 'Credit',
          amount: payload.amount,
          currency: payload.currency,
          description: `Cash refunded to customer ${payload.customerId || ''}`,
          metadata: { ...payload.metadata, refundType: 'Full' }
        }
      );

      // Calculate totals
      ledgerEntries.forEach(entry => {
        if (entry.entry_type === 'Debit') {
          totalDebits += entry.amount;
        } else {
          totalCredits += entry.amount;
        }
      });

      // Ensure balance
      if (Math.abs(totalDebits - totalCredits) > 0.001) {
        throw new Error('Ledger entries are not balanced');
      }

      break;

    case 'PaymentPartiallyRefunded':
      // Ensure required fields are present
      if (!payload.originalAmount || !payload.refundAmount || !payload.currency || !payload.merchantId) {
        throw new Error('Missing required fields in payload for PaymentPartiallyRefunded');
      }

      // Validate refund amount
      if (payload.refundAmount > payload.originalAmount) {
        throw new Error('Refund amount cannot exceed the original payment amount');
      }

      // Fetch necessary accounts
      const merchantPayableAccountPartialRefund = await findOrCreateAccount({
        account_name: `Merchant Payable - ${payload.merchantId}`,
        currency: payload.currency,
        account_type: 'Liability',
        nature: 'Credit',
      });

      // Check if merchant has sufficient funds
      if (merchantPayableAccountPartialRefund.balance < payload.refundAmount) {
        throw new Error('Insufficient funds in merchant account for partial refund');
      }

      const cashAccountPartialRefund = await findOrCreateAccount({
        account_name: `Cash - ${payload.currency}`,
        currency: payload.currency,
        account_type: 'Asset',
        nature: 'Debit',
      });

      // Create ledger entries
      ledgerEntries.push(
        // Debit Merchant Payable (Liability decrease)
        {
          account_id: merchantPayableAccountPartialRefund.account_id,
          entry_type: 'Debit',
          amount: payload.refundAmount,
          currency: payload.currency,
          description: `Partial refund to customer for merchant ${payload.merchantId}`,
          metadata: { 
            ...payload.metadata, 
            refundType: 'Partial',
            originalAmount: payload.originalAmount
          }
        },
        // Credit Cash (Asset decrease)
        {
          account_id: cashAccountPartialRefund.account_id,
          entry_type: 'Credit',
          amount: payload.refundAmount,
          currency: payload.currency,
          description: `Cash partially refunded to customer ${payload.customerId || ''}`,
          metadata: { 
            ...payload.metadata, 
            refundType: 'Partial',
            originalAmount: payload.originalAmount
          }
        }
      );

      // Calculate totals
      ledgerEntries.forEach(entry => {
        if (entry.entry_type === 'Debit') {
          totalDebits += entry.amount;
        } else {
          totalCredits += entry.amount;
        }
      });

      // Ensure balance
      if (Math.abs(totalDebits - totalCredits) > 0.001) {
        throw new Error('Ledger entries are not balanced');
      }

      break;

    // Add cases for other event types (PaymentRefunded, etc.) with similar logic

    default:
      throw new Error(`Unsupported event type: ${eventType}`);
  }

  const createdEntries = [];

  // Save entries and update account balances
  for (const entryData of ledgerEntries) {
    const ledgerEntry = new LedgerEntry({
      entry_id: uuidv4(),
      entryGroupId,
      transaction_id: transactionId,
      event_id: eventId,
      account_id: entryData.account_id,
      entry_type: entryData.entry_type,
      amount: entryData.amount,
      currency: entryData.currency,
      description: entryData.description,
      metadata: {
        ...entryData.metadata,
        event_id: eventId  // Add event_id to metadata
      },
    });

    await ledgerEntry.save();
    await updateAccountBalance(
      ledgerEntry.account_id,
      ledgerEntry.entry_type,
      ledgerEntry.amount,
      ledgerEntry.currency
    );

    createdEntries.push(ledgerEntry);
  }

  return createdEntries;
}

function evaluateConditions(conditions, payload) {
  // Since we're not using conditions, we'll always return true
  return true;
}

// Event Schema
const eventSchema = new mongoose.Schema({
  event_id: { type: String, default: uuidv4, unique: true },
  event_type: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  created_at: { type: Date, default: Date.now },
});

const Event = mongoose.model('Event', eventSchema);

// ==========================
// API Endpoints
// ==========================

// --- Account Management Endpoints ---

// Create Account
router.post('/accounts', async (req, res) => {
  const {
    accountName,
    nature,
    accountType,
    parentAccountId,
    currency,
    status,
    metadata,
  } = req.body;
  const uniqueId = uuidv4();
  try {
    const newAccount = new Account({
      account_number: uniqueId,
      account_name: accountName,
      account_type: accountType,
      parent_account_id: parentAccountId,
      currency: currency,
      nature,
      balance: 0,
      status: status,
      metadata: metadata,
    });
    const result = await newAccount.save();
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Account
router.put('/accounts/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const {
    accountNumber,
    accountName,
    nature,
    accountType,
    parentAccountId,
    currency,
    status,
    metadata,
  } = req.body;

  try {
    const updatedAccount = await Account.findOneAndUpdate(
      { account_id: accountId },
      {
        account_number: accountNumber,
        account_name: accountName,
        nature: nature,
        account_type: accountType,
        parent_account_id: parentAccountId,
        currency: currency,
        status: status,
        metadata: metadata,
        updated_at: Date.now(),
      },
      { new: true }
    );
    if (!updatedAccount) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.status(200).json(updatedAccount);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Account Details
router.get('/accounts/:accountId', async (req, res) => {
  const { accountId } = req.params;

  try {
    const account = await Account.findOne({ account_id: accountId });
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    res.status(200).json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Accounts
router.get('/accounts', async (req, res) => {
  const { accountType, currency, status } = req.query;
  const filter = {};

  if (accountType) filter.account_type = accountType;
  if (currency) filter.currency = currency;
  if (status) filter.status = status;

  try {
    const accounts = await Account.find(filter);
    res.status(200).json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Accounting Entries API ---

// 1. Create Accounting Entries
router.post('/accounting-entries', async (req, res) => {
  const { transactionId, eventId, entries } = req.body;

  // Validate entries
  if (!entries || !Array.isArray(entries) || entries.length < 2) {
    return res.status(400).json({ error: 'At least two entries are required' });
  }

  const entryGroupId = uuidv4();
  let totalDebits = 0;
  let totalCredits = 0;
  const ledgerEntries = [];

  try {
    // Process entries
    for (const entry of entries) {
      const { accountId, entryType, amount, currency, description, metadata } = entry;

      if (!accountId || !entryType || !amount || !currency) {
        return res.status(400).json({ error: 'Invalid entry data' });
      }

      const ledgerEntry = new LedgerEntry({
        entry_id: uuidv4(),
        entryGroupId,
        transaction_id: transactionId,
        event_id: eventId,
        account_id: accountId,
        entry_type: entryType,
        amount,
        currency,
        description,
        metadata,
      });

      ledgerEntries.push(ledgerEntry);

      // Update totals
      if (entryType === 'Debit') {
        totalDebits += amount;
      } else if (entryType === 'Credit') {
        totalCredits += amount;
      } else {
        return res.status(400).json({ error: 'Invalid entry type' });
      }
    }

    // Validate that debits equal credits
    if (totalDebits.toFixed(2) !== totalCredits.toFixed(2)) {
      return res.status(400).json({ error: 'Total debits must equal total credits' });
    }

    // Save entries and update account balances
    for (const ledgerEntry of ledgerEntries) {
      await ledgerEntry.save();
      await updateAccountBalance(
        ledgerEntry.account_id,
        ledgerEntry.entry_type,
        ledgerEntry.amount,
        ledgerEntry.currency
      );
    }

    res.status(201).json({
      entryGroupId,
      entries: ledgerEntries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Retrieve Accounting Entry
router.get('/accounting-entries/:entryId', async (req, res) => {
  const { entryId } = req.params;
 
  try {
    const entry = await LedgerEntry.findOne({ entry_id: entryId });
    if (!entry) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    res.status(200).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. List Accounting Entries
router.get('/accounting-entries', async (req, res) => {
  const {
    accountId,
    transactionId,
    eventId,
    entryType,
    startDate,
    endDate,
    isReversal,
    page = 1,
    pageSize = 50,
  } = req.query;

  const filter = {};
  if (accountId) filter.account_id = accountId;
  if (transactionId) filter.transaction_id = transactionId;
  if (eventId) filter.event_id = eventId;
  if (entryType) filter.entry_type = entryType;
  if (isReversal !== undefined) filter.isReversal = isReversal === 'true';

  if (startDate) filter.timestamp = { $gte: new Date(startDate) };
  if (endDate) {
    filter.timestamp = filter.timestamp || {};
    filter.timestamp.$lte = new Date(endDate);
  }

  try {
    const totalEntries = await LedgerEntry.countDocuments(filter);
    const totalPages = Math.ceil(totalEntries / pageSize);
    const entries = await LedgerEntry.find(filter)
      .skip((page - 1) * pageSize)
      .limit(Number(pageSize));

    res.status(200).json({
      entries,
      pagination: {
        page: Number(page),
        pageSize: Number(pageSize),
        totalPages,
        totalEntries,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Reverse Accounting Entries
router.post('/accounting-entries/:entryGroupId/reverse', async (req, res) => {
  const { entryGroupId } = req.params;

  try {
    const originalEntries = await LedgerEntry.find({ entryGroupId });
    if (!originalEntries || originalEntries.length === 0) {
      return res.status(404).json({ error: 'Entry group not found' });
    }

    // Check if entries have already been reversed
    const alreadyReversed = originalEntries.some((entry) => entry.isReversed);
    if (alreadyReversed) {
      return res.status(400).json({ error: 'This entry group has already been reversed' });
    }

    const reversalEntryGroupId = uuidv4();
    const reversalEntries = [];

    for (const originalEntry of originalEntries) {
      const account = await Account.findOne({ account_id: originalEntry.account_id });
      if (!account) {
        throw new Error(`Account with ID ${originalEntry.account_id} not found`);
      }

      let reversalAmount = originalEntry.amount;
      let reversalCurrency = originalEntry.currency;

      // If the account currency doesn't match the entry currency, convert the amount
      if (account.currency !== originalEntry.currency) {
        const exchangeRate = getExchangeRate(originalEntry.currency, account.currency);
        reversalAmount = originalEntry.amount * exchangeRate;
        reversalCurrency = account.currency;
      }

      const reversalEntry = new LedgerEntry({
        entry_id: uuidv4(),
        entryGroupId: reversalEntryGroupId,
        transaction_id: originalEntry.transaction_id,
        event_id: originalEntry.event_id,
        account_id: originalEntry.account_id,
        entry_type: originalEntry.entry_type === 'Debit' ? 'Credit' : 'Debit',
        amount: reversalAmount,
        currency: reversalCurrency,
        description: `Reversal of entry ${originalEntry.entry_id}`,
        metadata: {
          ...originalEntry.metadata,
          originalEntryId: originalEntry.entry_id,
          originalAmount: originalEntry.amount,
          originalCurrency: originalEntry.currency,
          reversalReason: req.body.reversalReason || 'Not specified',
          exchangeRate: account.currency !== originalEntry.currency ? 
            getExchangeRate(originalEntry.currency, account.currency) : 1
        },
        isReversal: true,
        originalEntryId: originalEntry.entry_id,
      });
      reversalEntries.push(reversalEntry);

      // Mark the original entry as reversed
      originalEntry.isReversed = true;
      await originalEntry.save();
    }

    // Save reversal entries and update account balances
    for (const reversalEntry of reversalEntries) {
      await reversalEntry.save();
      await updateAccountBalance(
        reversalEntry.account_id,
        reversalEntry.entry_type,
        reversalEntry.amount,
        reversalEntry.currency
      );
    }

    res.status(201).json({
      reversalEntryGroupId,
      reversalEntries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Rule Processing Flow ---

router.post('/events', async (req, res) => {
  const { eventType, payload } = req.body;

  try {
    // Save the event
    const event = new Event({
      event_type: eventType,
      payload: payload,
    });
    await event.save();

    // Process the event
    const createdEntries = await executeActions(eventType, { ...payload, event_id: event.event_id });

    res.status(200).json({
      message: 'Event processed successfully',
      event_id: event.event_id,
      entries: createdEntries
    });
  } catch (err) {
    if (err.message.includes('Insufficient funds') || err.message.includes('Refund amount cannot exceed')) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});


router.post('/event', async (req, res) => {
  const { eventType, payload } = req.body;

  try {
    // Save the event
    const event = new Event({
      event_type: eventType,
      payload: payload,
    });
    await event.save();

    // Process the event
    const createdEntries = await executeActions(eventType, { ...payload, event_id: event.event_id });

    res.status(200).json({
      message: 'Event processed successfully',
      event_id: event.event_id,
      entries: createdEntries
    });
  } catch (err) {
    if (err.message.includes('Insufficient funds') || err.message.includes('Refund amount cannot exceed')) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});


// API to get current ledger configuration
router.get('/config', (req, res) => {
  res.json(ledgerConfig);
});

// API to update ledger configuration
router.put('/config', (req, res) => {
  try {
    const newConfig = req.body;
    
    // Validate the new configuration
    if (!validateConfig(newConfig)) {
      return res.status(400).json({ error: 'Invalid configuration format' });
    }

    // Update the in-memory configuration
    ledgerConfig = newConfig;

    // Log the updated configuration
    console.log('Configuration updated:', JSON.stringify(ledgerConfig, null, 2));

    res.json({ message: 'Configuration updated successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update configuration: ' + error.message });
  }
});

// Helper function to validate configuration
function validateConfig(config) {
  // Add your validation logic here
  // This is a basic example, you should add more comprehensive checks
  return (
    config &&
    typeof config === 'object' &&
    config.accounts &&
    config.fx_fees &&
    config.transaction_fee_percentage &&
    config.transaction_fee_fixed &&
    config.payment_processing
  );
}

// NOTE: This function has been commented out as it is no longer in use.
// If you need to recalculate balances, please refer to the new implementation.

// Endpoint to delete all entries with description "Discrepancy adjustment"
router.delete('/delete-discrepancy-entries', async (req, res) => {
  try {
    const result = await LedgerEntry.deleteMany({ description: "Discrepancy adjustment" });
    console.log(`${result.deletedCount} discrepancy adjustment entries were deleted.`);
    res.status(200).json({ message: `${result.deletedCount} discrepancy adjustment entries were deleted.` });
  } catch (error) {
    console.error('Error deleting discrepancy adjustment entries:', error.message);
    res.status(500).json({ error: 'Failed to delete discrepancy adjustment entries: ' + error.message });
  }
});
// Endpoint to trigger balance recalculation
router.post('/recalculate-balances', async (req, res) => {
  try {
    console.log('Starting manual balance recalculation...');
    await recalculateBalances();
    console.log('Manual balance recalculation completed.');
    res.status(200).json({ message: 'Balance recalculation completed successfully' });
  } catch (error) {
    console.error('Error during manual balance recalculation:', error.message);
    res.status(500).json({ error: 'Failed to recalculate balances: ' + error.message });
  }
});

// Schedule the balance recalculation to run every day at midnight
// cron.schedule('0 0 * * *', async () => {
//   try {
//     console.log('Starting balance recalculation...');
//     await recalculateBalances();
//     console.log('Balance recalculation completed.');
//   } catch (error) {
//     console.error('Error during balance recalculation:', error.message);
//   }
// });

;

// Export the router
module.exports = router;
