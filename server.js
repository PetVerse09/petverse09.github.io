"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

// ==================================================
// ET TOKEN CONFIGURATION
// ==================================================

const PORT = Number(process.env.PORT || 10000);

const PI_API_BASE = (
  process.env.PI_API_BASE ||
  "https://api.testnet.minepi.com"
).replace(/\/+$/, "");

const ET_MAX_SUPPLY = 40_000_000;
const ET_MINING_POOL = 20_000_000;

const BASE_MINING_RATE = 0.01; // ET per hour
const MINING_DURATION_HOURS = 24;
const MINING_DURATION_MS =
  MINING_DURATION_HOURS * 60 * 60 * 1000;

// ==================================================
// DATABASE
// ==================================================

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

// ==================================================
// APP CONFIGURATION
// ==================================================

app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL
          .split(",")
          .map((v) => v.trim())
      : true,

    methods: ["GET", "POST"],

    allowedHeaders: [
      "Content-Type",
      "Authorization"
    ]
  })
);

app.use(
  express.json({
    limit: "100kb"
  })
);

// ==================================================
// HELPERS
// ==================================================

function generateReferralCode(username) {
  return String(username)
    .trim()
    .toLowerCase();
}

function getBearerToken(req) {
  const header =
    req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header
    .substring(7)
    .trim();
}

// ==================================================
// PI AUTHENTICATION
// ==================================================

async function verifyPiAccessToken(accessToken) {
  if (!accessToken) {
    throw new Error(
      "Missing Pi access token"
    );
  }

  const response = await fetch(
    `${PI_API_BASE}/v2/me`,
    {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      "Invalid Pi authentication"
    );
  }

  const data =
    await response.json();

  if (
    !data ||
    !data.uid ||
    !data.username
  ) {
    throw new Error(
      "Invalid Pi user response"
    );
  }

  return {
    uid: String(data.uid),
    username: String(data.username)
  };
}

// ==================================================
// REPUTATION SYSTEM
// ==================================================

function getReputationMultiplier(
  reputationScore
) {
  const score =
    Number(reputationScore || 0);

  if (score >= 1000) {
    return 2.00;
  }

  if (score >= 750) {
    return 1.75;
  }

  if (score >= 500) {
    return 1.50;
  }

  if (score >= 250) {
    return 1.25;
  }

  if (score >= 100) {
    return 1.10;
  }

  return 1.00;
}

// ==================================================
// HALVING SYSTEM
// ==================================================

function getHalvingMultiplier(
  miningPoolUsed
) {
  const used =
    Number(miningPoolUsed || 0);

  const percentage =
    used / ET_MINING_POOL;

  // First 25% = 100%
  if (percentage < 0.25) {
    return 1.00;
  }

  // 25% - 50% = 50%
  if (percentage < 0.50) {
    return 0.50;
  }

  // 50% - 75% = 25%
  if (percentage < 0.75) {
    return 0.25;
  }

  // 75% - 90% = 12.5%
  if (percentage < 0.90) {
    return 0.125;
  }

  // 90% - 100% = 6.25%
  return 0.0625;
}

// ==================================================
// MINING POOL ACCOUNTING
// ==================================================

async function getMiningPoolUsed(
  client = pool
) {
  const result =
    await client.query(`
      SELECT
        COALESCE(
          SUM(amount),
          0
        ) AS total
      FROM et_ledger
      WHERE transaction_type =
        'MINING_REWARD'
    `);

  return Number(
    result.rows[0].total || 0
  );
}

// ==================================================
// DATABASE INITIALIZATION
// ==================================================

async function initializeDatabase() {

  // ------------------------------------------------
  // MEMBERS
  // ------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS et_members (

      id BIGSERIAL PRIMARY KEY,

      pi_uid TEXT NOT NULL UNIQUE,

      pi_username TEXT NOT NULL UNIQUE,

      referral_code TEXT NOT NULL UNIQUE,

      referred_by TEXT,

      reputation_score
        INTEGER NOT NULL DEFAULT 0,

      et_balance
        NUMERIC(30, 8)
        NOT NULL DEFAULT 0,

      mining_active
        BOOLEAN NOT NULL DEFAULT FALSE,

      created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_et_members_referral_code

    ON et_members(referral_code);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_et_members_pi_uid

    ON et_members(pi_uid);
  `);

  // ------------------------------------------------
  // LEDGER
  // ------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS et_ledger (

      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES et_members(id)
        ON DELETE CASCADE,

      transaction_type TEXT NOT NULL,

      amount
        NUMERIC(30, 8)
        NOT NULL,

      reference_id TEXT UNIQUE,

      created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_et_ledger_member

    ON et_ledger(member_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_et_ledger_type

    ON et_ledger(transaction_type);
  `);

  // ------------------------------------------------
  // MINING SESSIONS
  // ------------------------------------------------

  await pool.query(`
    CREATE TABLE IF NOT EXISTS
    et_mining_sessions (

      id BIGSERIAL PRIMARY KEY,

      member_id BIGINT NOT NULL
        REFERENCES et_members(id)
        ON DELETE CASCADE,

      started_at
        TIMESTAMPTZ NOT NULL,

      ends_at
        TIMESTAMPTZ NOT NULL,

      rate
        NUMERIC(30, 8)
        NOT NULL DEFAULT 0,

      status
        TEXT NOT NULL DEFAULT 'ACTIVE',

      claimed_amount
        NUMERIC(30, 8)
        NOT NULL DEFAULT 0,

      created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS
    idx_et_mining_member

    ON et_mining_sessions(member_id);
  `);

  console.log(
    "ET database initialized successfully."
  );
}

// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {

  res.json({
    success: true,

    project: "ET Token",

    symbol: "ET",

    maxSupply:
      ET_MAX_SUPPLY,

    miningPool:
      ET_MINING_POOL,

    baseMiningRate:
      BASE_MINING_RATE,

    miningDurationHours:
      MINING_DURATION_HOURS,

    network:
      "Pi Testnet",

    environment:
      process.env.NODE_ENV ||
      "development",

    status:
      "ONLINE"
  });
});

// ==================================================
// PI LOGIN / ET ACCOUNT CREATION
// ==================================================

app.post(
  "/api/auth/pi",
  async (req, res) => {

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      const referralCode =
        generateReferralCode(
          piUser.username
        );

      const existing =
        await pool.query(
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

      // --------------------------------------------
      // NEW USER
      // --------------------------------------------

      if (
        existing.rows.length === 0
      ) {

        const inserted =
          await pool.query(
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

        member =
          inserted.rows[0];

      }

      // --------------------------------------------
      // EXISTING USER
      // --------------------------------------------

      else {

        const updated =
          await pool.query(
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

        member =
          updated.rows[0];
      }

      res.json({

        success: true,

        user: member

      });

    }

    catch (error) {

      console.error(
        "Pi authentication error:",
        error
      );

      res.status(401).json({

        success: false,

        error:
          "Pi authentication failed"

      });
    }
  }
);

// ==================================================
// PROFILE
// ==================================================

app.post(
  "/api/profile",
  async (req, res) => {

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      const result =
        await pool.query(
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

      if (
        result.rows.length === 0
      ) {

        return res.status(404)
          .json({

            success: false,

            error:
              "ET account not found"

          });
      }

      res.json({

        success: true,

        profile:
          result.rows[0]

      });

    }

    catch (error) {

      console.error(
        "Profile error:",
        error
      );

      res.status(401).json({

        success: false,

        error:
          "Unauthorized"

      });
    }
  }
);

// ==================================================
// REFERRAL LINK
// ==================================================

app.post(
  "/api/referral/link",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const referralCode =
        String(
          req.body.referralCode ||
          ""
        )
          .trim()
          .toLowerCase();

      if (!referralCode) {

        return res.status(400)
          .json({

            success: false,

            error:
              "Referral code is required"

          });
      }

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      await client.query(
        "BEGIN"
      );

      // Lock current member
      const memberResult =
        await client.query(
          `
          SELECT *
          FROM et_members
          WHERE pi_uid = $1
          FOR UPDATE
          `,
          [piUser.uid]
        );

      if (
        memberResult.rows.length === 0
      ) {

        throw new Error(
          "ET account not found"
        );
      }

      const member =
        memberResult.rows[0];

      if (member.referred_by) {

        throw new Error(
          "Referral is already linked"
        );
      }

      if (
        member.referral_code ===
        referralCode
      ) {

        throw new Error(
          "Self referral is not allowed"
        );
      }

      // Lock referrer
      const referrerResult =
        await client.query(
          `
          SELECT
            id,
            pi_username,
            referral_code
          FROM et_members
          WHERE referral_code = $1
          FOR UPDATE
          `,
          [referralCode]
        );

      if (
        referrerResult.rows.length === 0
      ) {

        throw new Error(
          "Referral code not found"
        );
      }

      const referrer =
        referrerResult.rows[0];

      // Link referral
      await client.query(
        `
        UPDATE et_members

        SET
          referred_by = $2,
          updated_at = NOW()

        WHERE id = $1
        `,
        [
          member.id,
          referrer.referral_code
        ]
      );

      // Give reputation point
      await client.query(
        `
        UPDATE et_members

        SET
          reputation_score =
            reputation_score + 1,

          updated_at = NOW()

        WHERE id = $1
        `,
        [member.id]
      );

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "Referral linked successfully",

        referredBy:
          referrer.pi_username

      });

    }

    catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "Referral error:",
        error
      );

      res.status(400).json({

        success: false,

        error:
          error.message

      });

    }

    finally {

      client.release();

    }
  }
);

// ==================================================
// REPUTATION
// ==================================================

app.post(
  "/api/reputation",
  async (req, res) => {

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      const result =
        await pool.query(
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

      if (
        result.rows.length === 0
      ) {

        return res.status(404)
          .json({

            success: false,

            error:
              "ET account not found"

          });
      }

      const reputation =
        Number(
          result.rows[0]
            .reputation_score
        );

      res.json({

        success: true,

        reputation: {

          score:
            reputation,

          multiplier:
            getReputationMultiplier(
              reputation
            ),

          referredBy:
            result.rows[0]
              .referred_by,

          miningActive:
            result.rows[0]
              .mining_active

        }

      });

    }

    catch (error) {

      console.error(
        "Reputation error:",
        error
      );

      res.status(401).json({

        success: false,

        error:
          "Unauthorized"

      });
    }
  }
);

// ==================================================
// START MINING
// ==================================================

app.post(
  "/api/mining/start",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      await client.query(
        "BEGIN"
      );

      // Lock member
      const memberResult =
        await client.query(
          `
          SELECT *
          FROM et_members
          WHERE pi_uid = $1
          FOR UPDATE
          `,
          [piUser.uid]
        );

      if (
        memberResult.rows.length === 0
      ) {

        throw new Error(
          "ET account not found"
        );
      }

      const member =
        memberResult.rows[0];

      // Prevent multiple sessions
      const activeResult =
        await client.query(
          `
          SELECT *
          FROM et_mining_sessions

          WHERE
            member_id = $1

            AND status = 'ACTIVE'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
          `,
          [member.id]
        );

      if (
        activeResult.rows.length > 0
      ) {

        throw new Error(
          "Mining session is already active"
        );
      }

      // Check mining pool
      const poolUsed =
        await getMiningPoolUsed(
          client
        );

      if (
        poolUsed >= ET_MINING_POOL
      ) {

        throw new Error(
          "ET mining pool has been exhausted"
        );
      }

      const halvingMultiplier =
        getHalvingMultiplier(
          poolUsed
        );

      const reputationMultiplier =
        getReputationMultiplier(
          member.reputation_score
        );

      const effectiveRate =
        BASE_MINING_RATE *
        halvingMultiplier *
        reputationMultiplier;

      const startedAt =
        new Date();

      const endsAt =
        new Date(
          startedAt.getTime() +
          MINING_DURATION_MS
        );

      const session =
        await client.query(
          `
          INSERT INTO
          et_mining_sessions (

            member_id,

            started_at,

            ends_at,

            rate,

            status

          )

          VALUES (
            $1,
            $2,
            $3,
            $4,
            'ACTIVE'
          )

          RETURNING *
          `,
          [
            member.id,
            startedAt,
            endsAt,
            effectiveRate
          ]
        );

      await client.query(
        `
        UPDATE et_members

        SET
          mining_active = TRUE,
          updated_at = NOW()

        WHERE id = $1
        `,
        [member.id]
      );

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "ET mining started",

        mining: {

          sessionId:
            session.rows[0].id,

          startedAt,

          endsAt,

          baseRate:
            BASE_MINING_RATE,

          reputationScore:
            member.reputation_score,

          reputationMultiplier,

          halvingMultiplier,

          effectiveRatePerHour:
            Number(
              effectiveRate.toFixed(8)
            )

        }

      });

    }

    catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "Mining start error:",
        error
      );

      res.status(400).json({

        success: false,

        error:
          error.message

      });

    }

    finally {

      client.release();

    }
  }
);

// ==================================================
// MINING STATUS
// ==================================================

app.post(
  "/api/mining/status",
  async (req, res) => {

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      const result =
        await pool.query(
          `
          SELECT
            ms.*,
            m.reputation_score

          FROM et_mining_sessions ms

          JOIN et_members m
            ON m.id = ms.member_id

          WHERE
            m.pi_uid = $1

            AND ms.status = 'ACTIVE'

          ORDER BY ms.id DESC

          LIMIT 1
          `,
          [piUser.uid]
        );

      if (
        result.rows.length === 0
      ) {

        return res.json({

          success: true,

          active: false,

          message:
            "No active mining session"

        });
      }

      const session =
        result.rows[0];

      const now =
        Date.now();

      const started =
        new Date(
          session.started_at
        ).getTime();

      const ends =
        new Date(
          session.ends_at
        ).getTime();

      const totalSeconds =
        Math.max(
          0,
          (ends - started) / 1000
        );

      const elapsedSeconds =
        Math.max(
          0,
          Math.min(
            (now - started) / 1000,
            totalSeconds
          )
        );

      const hours =
        elapsedSeconds / 3600;

      const earned =
        hours *
        Number(session.rate);

      const claimAvailable =
        now >= ends;

      res.json({

        success: true,

        active: true,

        mining: {

          sessionId:
            session.id,

          startedAt:
            session.started_at,

          endsAt:
            session.ends_at,

          ratePerHour:
            Number(session.rate),

          reputationScore:
            Number(
              session.reputation_score
            ),

          earned:
            Number(
              earned.toFixed(8)
            ),

          claimAvailable

        }

      });

    }

    catch (error) {

      console.error(
        "Mining status error:",
        error
      );

      res.status(401).json({

        success: false,

        error:
          "Unauthorized"

      });
    }
  }
);

// ==================================================
// CLAIM MINING REWARD
// ==================================================

app.post(
  "/api/mining/claim",
  async (req, res) => {

    const client =
      await pool.connect();

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      await client.query(
        "BEGIN"
      );

      // Lock member
      const memberResult =
        await client.query(
          `
          SELECT *
          FROM et_members
          WHERE pi_uid = $1
          FOR UPDATE
          `,
          [piUser.uid]
        );

      if (
        memberResult.rows.length === 0
      ) {

        throw new Error(
          "ET account not found"
        );
      }

      const member =
        memberResult.rows[0];

      // Lock active session
      const sessionResult =
        await client.query(
          `
          SELECT *
          FROM et_mining_sessions

          WHERE
            member_id = $1

            AND status = 'ACTIVE'

          ORDER BY id DESC

          LIMIT 1

          FOR UPDATE
          `,
          [member.id]
        );

      if (
        sessionResult.rows.length === 0
      ) {

        throw new Error(
          "No active mining session"
        );
      }

      const session =
        sessionResult.rows[0];

      const now =
        new Date();

      if (
        now <
        new Date(
          session.ends_at
        )
      ) {

        throw new Error(
          "Mining session is not complete yet"
        );
      }

      // --------------------------------------------
      // CHECK MINING POOL
      // --------------------------------------------

      const poolUsed =
        await getMiningPoolUsed(
          client
        );

      const fullReward =
        Number(session.rate) *
        MINING_DURATION_HOURS;

      const remaining =
        Math.max(
          0,
          ET_MINING_POOL -
          poolUsed
        );

      const reward =
        Math.min(
          fullReward,
          remaining
        );

      if (reward <= 0) {

        throw new Error(
          "No ET remaining in mining pool"
        );
      }

      // --------------------------------------------
      // UNIQUE TRANSACTION ID
      // --------------------------------------------

      const referenceId =
        crypto.randomUUID();

      // --------------------------------------------
      // LEDGER ENTRY
      // --------------------------------------------

      await client.query(
        `
        INSERT INTO et_ledger (

          member_id,

          transaction_type,

          amount,

          reference_id

        )

        VALUES (
          $1,
          'MINING_REWARD',
          $2,
          $3
        )
        `,
        [
          member.id,
          reward,
          referenceId
        ]
      );

      // --------------------------------------------
      // UPDATE BALANCE
      // --------------------------------------------

      await client.query(
        `
        UPDATE et_members

        SET

          et_balance =
            et_balance + $2,

          mining_active =
            FALSE,

          reputation_score =
            reputation_score + 1,

          updated_at =
            NOW()

        WHERE id = $1
        `,
        [
          member.id,
          reward
        ]
      );

      // --------------------------------------------
      // COMPLETE SESSION
      // --------------------------------------------

      await client.query(
        `
        UPDATE et_mining_sessions

        SET

          status =
            'COMPLETED',

          claimed_amount =
            $2

        WHERE id = $1
        `,
        [
          session.id,
          reward
        ]
      );

      await client.query(
        "COMMIT"
      );

      res.json({

        success: true,

        message:
          "ET mining reward claimed",

        reward:
          Number(
            reward.toFixed(8)
          ),

        newReputationScore:
          Number(
            member.reputation_score
          ) + 1,

        referenceId

      });

    }

    catch (error) {

      await client.query(
        "ROLLBACK"
      );

      console.error(
        "Mining claim error:",
        error
      );

      res.status(400).json({

        success: false,

        error:
          error.message

      });

    }

    finally {

      client.release();

    }
  }
);

// ==================================================
// BALANCE
// ==================================================

app.post(
  "/api/balance",
  async (req, res) => {

    try {

      const accessToken =
        req.body.accessToken ||
        getBearerToken(req);

      const piUser =
        await verifyPiAccessToken(
          accessToken
        );

      const result =
        await pool.query(
          `
          SELECT
            pi_username,
            et_balance

          FROM et_members

          WHERE pi_uid = $1
          `,
          [piUser.uid]
        );

      if (
        result.rows.length === 0
      ) {

        return res.status(404)
          .json({

            success: false,

            error:
              "ET account not found"

          });
      }

      res.json({

        success: true,

        username:
          result.rows[0]
            .pi_username,

        balance:
          Number(
            result.rows[0]
              .et_balance
          )

      });

    }

    catch (error) {

      console.error(
        "Balance error:",
        error
      );

      res.status(401).json({

        success: false,

        error:
          "Unauthorized"

      });
    }
  }
);

// ==================================================
// ERROR HANDLER
// ==================================================

app.use(
  (req, res) => {

    res.status(404).json({

      success: false,

      error:
        "Endpoint not found"

    });
  }
);

// ==================================================
// SERVER START
// ==================================================

async function startServer() {

  try {

    await initializeDatabase();

    app.listen(
      PORT,
      () => {

        console.log(`
========================================
             ET TOKEN
========================================

Symbol:          ET
Max Supply:      ${ET_MAX_SUPPLY.toLocaleString()} ET
Mining Pool:     ${ET_MINING_POOL.toLocaleString()} ET
Base Rate:       ${BASE_MINING_RATE} ET/hour
Mining Duration: ${MINING_DURATION_HOURS} hours
Network:         Pi Testnet

Status:          ONLINE
Port:            ${PORT}

========================================
        `);

      }
    );

  }

  catch (error) {

    console.error(
      "Failed to start ET backend:",
      error
    );

    process.exit(1);
  }
}

startServer();