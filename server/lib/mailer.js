'use strict';

// Email abstraction. In production (SMTP_URL set) it sends via nodemailer; in
// development it captures messages into an in-memory outbox and logs them, so
// the invite/reset flows are fully exercisable without a mail server. The
// route layer also hands the caller the link directly when not in production,
// so a solo developer can copy-paste it.

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 4000}`;
const isProd = process.env.NODE_ENV === 'production';

const outbox = []; // dev/test capture

async function send({ to, subject, text }) {
  const msg = { to, subject, text, at: new Date().toISOString() };

  if (process.env.SMTP_URL) {
    let nodemailer;
    try {
      nodemailer = require('nodemailer');
    } catch {
      throw new Error('SMTP_URL is set but nodemailer is not installed (run: npm install nodemailer)');
    }
    const transport = nodemailer.createTransport(process.env.SMTP_URL);
    await transport.sendMail({
      from: process.env.MAIL_FROM || 'no-reply@profile-transformer.local',
      to,
      subject,
      text,
    });
    return { sent: true };
  }

  // dev / test: capture instead of send
  outbox.push(msg);
  if (!process.env.SILENCE_MAIL) {
    console.log(`\n[mailer:dev] to=${to} · ${subject}\n${text}\n`);
  }
  return { sent: false, captured: true };
}

function appUrl(path = '') {
  return `${APP_URL.replace(/\/$/, '')}${path}`;
}

module.exports = { send, appUrl, outbox, isProd };
