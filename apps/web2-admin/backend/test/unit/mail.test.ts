/**
 * The admin's mail: the SMTP settings and the sentences a bad one stops the start with, the connection the sender
 * opens, and what a failed send is recorded as. `pnpm test`.
 *
 * Two tests speak to a local server that offers no encryption, through nodemailer itself: the sender gives up before
 * it signs in, and the server never sees the password.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { describe, it } from 'node:test';

import nodemailer from 'nodemailer';

import {
  MailSendError,
  NO_MAILER,
  SmtpMailer,
  mailFailureSentence,
  mailerFrom,
  smtpTransportOptions,
  type SmtpTransport,
  type SmtpTransportOptions,
} from '../../src/domain/mail/Mailer.js';
import { describeMailSettings, mailSettingsFrom, type MailSettings } from '../../src/utils/mailSettings.js';

const PASSWORD = 'mail-test-password-that-stands-for-nothing';

const ENV = {
  SMTP_HOST: 'smtp.example.org',
  SMTP_PORT: '587',
  SMTP_USER: 'alerts-user',
  SMTP_PASSWORD: PASSWORD,
  SMTP_FROM: ' Alerts@Example.org ',
};

const SETTINGS: MailSettings = {
  host: 'smtp.example.org',
  port: 587,
  user: 'alerts-user',
  password: PASSWORD,
  from: 'alerts@example.org',
};

function startProblem(env: Record<string, string>): string {
  try {
    mailSettingsFrom(env);
  } catch (error) {
    return (error as Error).message;
  }
  return '(started)';
}

describe('the mail settings', () => {
  it('are off with SMTP_HOST empty, whatever else is set', () => {
    assert.equal(mailSettingsFrom({}), null);
    assert.equal(mailSettingsFrom({ ...ENV, SMTP_HOST: '  ' }), null);
    assert.match(describeMailSettings(null), /^off \(SMTP_HOST empty\)/);
  });

  it('read a host, 587 or 465, the user, the password and the sender in lower case', () => {
    assert.deepEqual(mailSettingsFrom(ENV), SETTINGS);
    assert.deepEqual(mailSettingsFrom({ ...ENV, SMTP_PORT: '465' }), { ...SETTINGS, port: 465 });
  });

  it('refuse any other port, an empty one among them, naming the key', () => {
    for (const port of ['', '25', '2525', '587.0', '0x24b', ' 465x']) {
      assert.match(startProblem({ ...ENV, SMTP_PORT: port }), /^Env var SMTP_PORT must be 587, with STARTTLS, or 465/);
    }
  });

  it('refuse a host with a scheme, a port or a space in it', () => {
    for (const host of ['smtps://smtp.example.org', 'smtp.example.org:587', 'smtp example.org', '-smtp.example.org']) {
      assert.match(startProblem({ ...ENV, SMTP_HOST: host }), /^Env var SMTP_HOST must be the SMTP server's host name/);
    }
  });

  it('require the user, the password and a sender address with a host, and never repeat the password', () => {
    assert.match(startProblem({ ...ENV, SMTP_USER: '' }), /^Env var SMTP_USER is required/);
    assert.match(startProblem({ ...ENV, SMTP_USER: 'two words' }), /^Env var SMTP_USER is required/);
    assert.match(startProblem({ ...ENV, SMTP_PASSWORD: ' ' }), /^Env var SMTP_PASSWORD is required/);
    assert.match(startProblem({ ...ENV, SMTP_FROM: '' }), /^Env var SMTP_FROM is required.*It is empty\.$/);
    assert.match(startProblem({ ...ENV, SMTP_FROM: 'alerts' }), /^Env var SMTP_FROM is required/);
    const multiline = startProblem({ ...ENV, SMTP_PASSWORD: `${PASSWORD}\nRCPT TO:<x@example.org>` });
    assert.equal(multiline, 'Env var SMTP_PASSWORD must be one line');
    for (const env of [
      { ...ENV, SMTP_PORT: '25' },
      { ...ENV, SMTP_FROM: 'alerts' },
      { ...ENV, SMTP_USER: '' },
    ]) {
      assert.ok(!startProblem(env).includes(PASSWORD));
    }
  });

  it('ship in the env sample with mail off and no password, so a copy of it sends nothing', () => {
    const sample = readFileSync(new URL('../../.env.sample', import.meta.url), 'utf8');
    assert.match(sample, /^SMTP_HOST=$/m);
    assert.match(sample, /^# SMTP_PASSWORD=$/m);
    assert.doesNotMatch(sample, /^SMTP_(PORT|USER|PASSWORD|FROM)=/m);
    const env = Object.fromEntries(
      [...sample.matchAll(/^(SMTP_[A-Z]+)=(.*)$/gm)].map((match) => [match[1]!, match[2]!] as const),
    );
    assert.equal(mailSettingsFrom(env), null);
  });

  it('are described for the boot log without the password', () => {
    const line = describeMailSettings(SETTINGS);
    assert.equal(line, 'smtp.example.org:587 (STARTTLS) as alerts@example.org, signed in as alerts-user');
    assert.ok(!line.includes(PASSWORD));
    assert.match(describeMailSettings({ ...SETTINGS, port: 465 }), /:465 \(TLS\)/);
  });
});

describe('the connection the sender opens', () => {
  it('on 587 must be upgraded with STARTTLS, and is never left plain', () => {
    const options = smtpTransportOptions(SETTINGS) as Record<string, unknown>;
    assert.equal(options.secure, false);
    assert.equal(options.requireTLS, true);
    assert.equal(options.ignoreTLS, false);
    assert.equal(options.opportunisticTLS, false);
    assert.deepEqual(options.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: 'smtp.example.org' });
  });

  it('on 465 speaks TLS from the start', () => {
    const options = smtpTransportOptions({ ...SETTINGS, port: 465 }) as Record<string, unknown>;
    assert.equal(options.secure, true);
    assert.equal(options.requireTLS, false);
  });

  it('times out, reads no file and fetches no address', () => {
    const options = smtpTransportOptions(SETTINGS) as Record<string, unknown>;
    assert.equal(options.connectionTimeout, 30_000);
    assert.equal(options.greetingTimeout, 30_000);
    assert.equal(options.socketTimeout, 60_000);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);
  });
});

/** A transport that records what it was handed, and fails with `failure` when one is given. */
function recordingTransport(failure?: unknown): {
  factory: (options: SmtpTransportOptions) => SmtpTransport;
  sent: unknown[];
  options: SmtpTransportOptions[];
} {
  const sent: unknown[] = [];
  const options: SmtpTransportOptions[] = [];
  return {
    sent,
    options,
    factory: (given) => {
      options.push(given);
      return {
        sendMail: (message) => {
          sent.push(message);
          return failure === undefined ? Promise.resolve({}) : Promise.reject(failure);
        },
      };
    },
  };
}

describe('the sender', () => {
  it('sends one plain text mail from SMTP_FROM to the whole list', async () => {
    const transport = recordingTransport();
    const mailer = new SmtpMailer(SETTINGS, transport.factory);
    assert.equal(mailer.configured, true);
    await mailer.send(['a@example.org', 'b@example.org'], { subject: 'Subject', text: 'Body' });
    assert.deepEqual(transport.sent, [
      { from: 'alerts@example.org', to: ['a@example.org', 'b@example.org'], subject: 'Subject', text: 'Body' },
    ]);
    assert.equal(transport.options.length, 1);
  });

  it('sends nothing to an empty list', async () => {
    const transport = recordingTransport();
    await assert.rejects(new SmtpMailer(SETTINGS, transport.factory).send([], { subject: 's', text: 't' }), {
      name: 'MailSendError',
      message: 'The email list is empty.',
    });
    assert.equal(transport.sent.length, 0);
  });

  it('turns a refusal into a sentence with the service answer, the password hidden', async () => {
    const refusal = Object.assign(new Error('Invalid login'), {
      code: 'EAUTH',
      response: `535 5.7.8 Authentication failed for ${PASSWORD}\r\nsecond line`,
    });
    const transport = recordingTransport(refusal);
    const failure = await new SmtpMailer(SETTINGS, transport.factory)
      .send(['a@example.org'], { subject: 's', text: 't' })
      .then(
        () => assert.fail('sent'),
        (error: unknown) => error,
      );
    assert.ok(failure instanceof MailSendError);
    assert.equal(
      failure.message,
      'The mail service refused the sign-in: check SMTP_USER and SMTP_PASSWORD. The mail service said: 535 5.7.8 Authentication failed for [hidden] second line',
    );
    assert.equal(failure.cause, refusal);
  });

  it('says what failed when the error has no code or answer, and cuts a long answer', () => {
    assert.equal(mailFailureSentence('boom', PASSWORD), 'The mail could not be sent.');
    assert.equal(mailFailureSentence({ code: 'ETIMEDOUT' }, PASSWORD), 'The mail service did not answer in time.');
    const long = mailFailureSentence(new Error('x'.repeat(500)), PASSWORD);
    assert.ok(long.endsWith('…'));
    assert.ok(long.length < 300);
  });

  it('is none while mail is off, and refuses to send', async () => {
    assert.equal(mailerFrom(null), NO_MAILER);
    assert.equal(NO_MAILER.configured, false);
    await assert.rejects(NO_MAILER.send(['a@example.org'], { subject: 's', text: 't' }), MailSendError);
    assert.ok(mailerFrom(SETTINGS) instanceof SmtpMailer);
  });
});

/**
 * A server on this host that greets, answers EHLO without STARTTLS, refuses a STARTTLS asked for all the same, and
 * records every line it is sent. It offers AUTH, so a client that would sign in over a plain connection does.
 */
async function plainSmtpServer(): Promise<{ port: number; lines: string[]; close: () => Promise<void> }> {
  const lines: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write('220 plain.example.org ESMTP\r\n');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk.toString('latin1');
      let end = buffered.indexOf('\r\n');
      while (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        lines.push(line);
        if (/^EHLO/i.test(line)) socket.write('250-plain.example.org\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^STARTTLS/i.test(line)) socket.write('454 4.7.0 TLS not available\r\n');
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
        end = buffered.indexOf('\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    lines,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** nodemailer's own transport, pointed at the local server in place of the port the settings name. */
function toLocalPort(port: number): (options: SmtpTransportOptions) => SmtpTransport {
  return (options) =>
    nodemailer.createTransport({
      ...(options as object),
      host: '127.0.0.1',
      port,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 5_000,
    } as never);
}

describe('the sender against a server that offers no encryption', () => {
  it('on 587 gives up before signing in, and the password never leaves the host', async () => {
    const server = await plainSmtpServer();
    try {
      const mailer = new SmtpMailer({ ...SETTINGS, host: 'localhost' }, toLocalPort(server.port));
      await assert.rejects(mailer.send(['a@example.org'], { subject: 's', text: 't' }), MailSendError);
      assert.ok(server.lines.some((line) => /^STARTTLS/i.test(line)));
      assert.ok(!server.lines.some((line) => /^(AUTH|MAIL|RCPT|DATA)/i.test(line)), server.lines.join(' | '));
      const plain = Buffer.from(`\u0000alerts-user\u0000${PASSWORD}`).toString('base64');
      assert.ok(!server.lines.some((line) => line.includes(PASSWORD) || line.includes(plain)));
    } finally {
      await server.close();
    }
  });

  it('on 465 sends nothing over a connection that is not TLS', async () => {
    const server = await plainSmtpServer();
    try {
      const mailer = new SmtpMailer({ ...SETTINGS, host: 'localhost', port: 465 }, toLocalPort(server.port));
      await assert.rejects(mailer.send(['a@example.org'], { subject: 's', text: 't' }), MailSendError);
      assert.ok(!server.lines.some((line) => /^(EHLO|AUTH|MAIL)/i.test(line)), server.lines.join(' | '));
    } finally {
      await server.close();
    }
  });
});
