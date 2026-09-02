"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE = (
  process.env.PI_API_BASE ||
  "https://api.testnet.minepi.com"
).replace(/\/+$/, "");

const ET_MAX_SUPPLY = 40_000_000;

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

if (!process.env.DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL is not configured.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false
});

// --------------------------------------------------
// APP
// --------------------------------------------------

app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map(v => v.trim())
      : true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"]
  })
);

app.use(express.json({ limit: "100kb" }));

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function generateReferralCode(username) {
  return String(username).trim().toLowerCase();
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.substring(7).trim();
}

async function verifyPiAccessToken(accessToken) {
  if (!accessToken) {
    throw new Error("Missing Pi access token");
  }

  const response = await fetch(`${PI_API_BASE}/v2/me`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error("Invalid Pi authentication");
  }

  const data = await response.json();

  if (!data || !data.uid || !data.username) {
    throw new Error("Invalid Pi user response");
  }

  return {
    uid: String(data.uid),
    username: String(data.username)
  };
}

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS et_members (
      id BIGSERIAL PRIMARY KEY,

      pi_uid TEXT NOT NULL UNIQUE,
      pi_username TEXT NOT NULL UNIQUE,

      referral_code TEXT NOT NULL UNIQUE,
      referred_by TEXT,

      reputation_score INTEGER NOT NULL DEFAULT 0,

      et_balance NUMERIC(30, 8) NOT NULL DEFAULT 0,

      mining_active BOOLEAN NOT NULL DEFAULT FALSE,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_et_members_referral_code
    ON et_members(referral_code);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_et_members_pi_uid
    ON et_members(pi_uid);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS et_ledger (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES et_members(id)
        ON DELETE CASCADE,

      transaction_type TEXT NOT NULL,

      amount NUMERIC(30, 8) NOT NULL,

      reference_id TEXT,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_et_ledger_member
    ON et_ledger(member_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS et_mining_sessions (
      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES et_members(id)
        ON DELETE CASCADE,

      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,

      rate NUMERIC(30, 8) NOT NULL DEFAULT 0,

      status TEXT NOT NULL DEFAULT 'ACTIVE',

      claimed_amount NUMERIC(30, 8) NOT NULL DEFAULT 0,

      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_et_mining_member
    ON et_mining_sessions(member_id);
  `);

  console.log("ET database initialized.");
}

// --------------------------------------------------
// HEALTH
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    project: "ET Token",
    symbol: "ET",
    maxSupply: ET_MAX_SUPPLY,
    network: "Pi Testnet",
    environment: process.env.NODE_ENV || "development",
    status: "ONLINE"
  });
});

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

app.post("/api/auth/pi", async (req, res) => {
  try {
    const accessToken =
      req.body.accessToken || getBearerToken(req);

    const piUser = await verifyPiAccessToken(accessToken);

    const referralCode = generateReferralCode(piUser.username);

    const existing = await pool.query(
      `
      SELECT
        id,
        pi_uid,
        pi_username,
        referral_code,
        referred_by,
        reputation_score,
        et_balance,
        mining_active
      FROM et_members
      WHERE pi_uid = $1
      `,
      [piUser.uid]
    );

    let member;

    if (existing.rows.length === 0) {
      const inserted = await pool.query(
        `
        INSERT INTO et_members (
          pi_uid,
          pi_username,
          referral_code
        )
        VALUES ($1, $2, $3)
        RETURNING
          id,
          pi_uid,
          pi_username,
          referral_code,
          referred_by,
          reputation_score,
          et_balance,
          mining_active
        `,
        [
          piUser.uid,
          piUser.username,
          referralCode
        ]
      );

      member = inserted.rows[0];
    } else {
      const updated = await pool.query(
        `
        UPDATE et_members
        SET
          pi_username = $2,
          referral_code = $3,
          updated_at = NOW()
        WHERE pi_uid = $1
        RETURNING
          id,
          pi_uid,
          pi_username,
          referral_code,
          referred_by,
          reputation_score,
          et_balance,
          mining_active
        `,
        [
          piUser.uid,
          piUser.username,
          referralCode
        ]
      );

      member = updated.rows[0];
    }

    res.json({
      success: true,
      user: member
    });
  } catch (error) {
    console.error("Pi authentication error:", error);

    res.status(401).json({
      success: false,
      error: "Pi authentication failed"
    });
  }
});

// --------------------------------------------------
// PROFILE
// --------------------------------------------------

app.post("/api/profile", async (req, res) => {
  try {
    const accessToken =
      req.body.accessToken || getBearerToken(req);

    const piUser = await verifyPiAccessToken(accessToken);

    const result = await pool.query(
      `
      SELECT
        id,
        pi_username,
        referral_code,
        referred_by,
        reputation_score,
        et_balance,
        mining_active,
        created_at
      FROM et_members
      WHERE pi_uid = $1
      `,
      [piUser.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "ET account not found"
      });
    }

    res.json({
      success: true,
      profile: result.rows[0]
    });
  } catch (error) {
    console.error("Profile error:", error);

    res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
});

// --------------------------------------------------
// REFERRAL
// --------------------------------------------------

app.post("/api/referral/link", async (req, res) => {
  const client = await pool.connect();

  try {
    const accessToken =
      req.body.accessToken || getBearerToken(req);

    const referralCode = String(
      req.body.referralCode || ""
    )
      .trim()
      .toLowerCase();

    if (!referralCode) {
      return res.status(400).json({
        success: false,
        error: "Referral code is required"
      });
    }

    const piUser = await verifyPiAccessToken(accessToken);

    await client.query("BEGIN");

    const memberResult = await client.query(
      `
      SELECT *
      FROM et_members
      WHERE pi_uid = $1
      FOR UPDATE
      `,
      [piUser.uid]
    );

    if (memberResult.rows.length === 0) {
      throw new Error("ET account not found");
    }

    const member = memberResult.rows[0];

    if (member.referred_by) {
      throw new Error("Referral is already linked");
    }

    if (member.referral_code === referralCode) {
      throw new Error("Self referral is not allowed");
    }

    const referrerResult = await client.query(
      `
      SELECT id, pi_username, referral_code
      FROM et_members
      WHERE referral_code = $1
      FOR UPDATE
      `,
      [referralCode]
    );

    if (referrerResult.rows.length === 0) {
      throw new Error("Referral code not found");
    }

    const referrer = referrerResult.rows[0];

    await client.query(
      `
      UPDATE et_members
      SET
        referred_by = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [member.id, referrer.referral_code]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Referral linked successfully",
      referredBy: referrer.pi_username
    });
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("Referral error:", error);

    res.status(400).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

// --------------------------------------------------
// REPUTATION
// --------------------------------------------------

app.post("/api/reputation", async (req, res) => {
  try {
    const accessToken =
      req.body.accessToken || getBearerToken(req);

    const piUser = await verifyPiAccessToken(accessToken);

    const result = await pool.query(
      `
      SELECT
        reputation_score,
        referred_by,
        mining_active
      FROM et_members
      WHERE pi_uid = $1
      `,
      [piUser.uid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: "ET account not found"
      });
    }

    res.json({
      success: true,
      reputation: result.rows[0]
    });
  } catch (error) {
    console.error("Reputation error:", error);

    res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
});

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found"
  });
});

// --------------------------------------------------
// START
// --------------------------------------------------

async function startServer() {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`
========================================
 ET TOKEN BACKEND
========================================
 Symbol:       ET
 Max Supply:   ${ET_MAX_SUPPLY.toLocaleString()}
 Network:      Pi Testnet
 Port:         ${PORT}
 Status:       ONLINE
========================================
      `);
    });
  } catch (error) {
    console.error("Failed to start ET backend:", error);
    process.exit(1);
  }
}

startServer();