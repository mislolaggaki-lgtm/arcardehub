// Passkeys in the browser: the two WebAuthn ceremonies (adding a passkey to the signed-in account,
// and signing in with one), plus converting their options and results to and from the JSON the
// server speaks (/api/passkey/...). Not offered inside the iPhone app: with a free Apple developer
// account the app can't have the Associated Domains permission WebAuthn needs there.
(function () {
  const inApp = /ArcadeHubApp/.test(navigator.userAgent);
  const api = () => (typeof API !== 'undefined' ? API : '/api'); // index.html's API base
  const supported = !inApp && !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

  const toBuffer = s => {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };
  const toBase64url = buf => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const creationOptions = o => ({
    ...o, challenge: toBuffer(o.challenge), user: { ...o.user, id: toBuffer(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: toBuffer(c.id) })),
  });
  const requestOptions = o => ({
    ...o, challenge: toBuffer(o.challenge),
    allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: toBuffer(c.id) })),
  });
  function credentialJSON(cred) {
    const r = cred.response;
    const out = {
      id: cred.id, rawId: toBase64url(cred.rawId), type: cred.type,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      response: { clientDataJSON: toBase64url(r.clientDataJSON) },
    };
    if (r.attestationObject) {
      out.response.attestationObject = toBase64url(r.attestationObject);
      out.response.transports = r.getTransports ? r.getTransports() : [];
    }
    if (r.authenticatorData) {
      out.response.authenticatorData = toBase64url(r.authenticatorData);
      out.response.signature = toBase64url(r.signature);
      if (r.userHandle) out.response.userHandle = toBase64url(r.userHandle);
    }
    return out;
  }

  // Errors people should see; cancelling (or a request we stopped) is quiet
  function friendly(e, adding) {
    const err = new Error(
      e.name === 'InvalidStateError' && adding ? 'This device already has a passkey for your account.'
        : e.name === 'NotAllowedError' || e.name === 'AbortError' ? 'Cancelled.'
          : adding ? 'Couldn\'t create a passkey on this device. Please try again.' : 'Couldn\'t use a passkey on this device. Please try again.');
    err.quiet = e.name === 'NotAllowedError' || e.name === 'AbortError';
    return err;
  }

  async function post(url, body, token) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    return { res, data: await res.json().catch(() => ({})) };
  }

  // Adds a passkey to the account this session token belongs to; resolves to the saved passkey
  async function register(token) {
    const o = await post(`${api()}/passkey/register/options`, {}, token);
    if (!o.res.ok) throw new Error(o.data.error || 'Couldn\'t start adding a passkey. Please try again.');
    let cred;
    try { cred = await navigator.credentials.create({ publicKey: creationOptions(o.data.options) }); }
    catch (e) { throw friendly(e, true); }
    const v = await post(`${api()}/passkey/register/verify`, { token: o.data.token, response: credentialJSON(cred) }, token);
    if (!v.res.ok) throw new Error(v.data.error || 'Couldn\'t add that passkey. Please try again.');
    return v.data.passkey;
  }

  // Signs in with a passkey. conditional: offered quietly in the username box's suggestions (autofill)
  // instead of asked for. Resolves to the server's answer { res, data }, shaped like /api/login's.
  let waiting = null; // the request in progress, so a new one can replace it
  async function signIn({ conditional = false } = {}) {
    if (waiting) waiting.abort();
    const ctrl = new AbortController();
    waiting = ctrl;
    try {
      const o = await post(`${api()}/passkey/login/options`, {});
      if (!o.res.ok) throw new Error(o.data.error || 'Couldn\'t start signing in with a passkey. Please try again.');
      if (ctrl.signal.aborted) throw friendly({ name: 'AbortError' });
      let cred;
      try {
        cred = await navigator.credentials.get({ publicKey: requestOptions(o.data.options), signal: ctrl.signal, ...(conditional ? { mediation: 'conditional' } : {}) });
      } catch (e) { throw friendly(e, false); }
      const v = await post(`${api()}/passkey/login/verify`, { token: o.data.token, response: credentialJSON(cred) });
      // A passkey removed from its account: ask the device to forget it too, where browsers allow that
      if (v.data.unknownCredential && PublicKeyCredential.signalUnknownCredential) {
        PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId: cred.id }).catch(() => {});
      }
      return v;
    } finally {
      if (waiting === ctrl) waiting = null;
    }
  }

  async function autofillAvailable() {
    try { return supported && !!PublicKeyCredential.isConditionalMediationAvailable && await PublicKeyCredential.isConditionalMediationAvailable(); }
    catch { return false; }
  }

  window.passkeys = { supported, inApp, register, signIn, autofillAvailable, cancel: () => waiting && waiting.abort() };
})();
