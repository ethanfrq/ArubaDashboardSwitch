// Barre latérale (navigation entre les pages), comptes utilisateurs, rôles, journal d'activité, « Mon profil »
// et formulaire des liens d'invitation. Utilise les fonctions de app.js : $, api, esc, toast, busy, canAdmin, ROLE…
(() => {
  'use strict';
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
  const fmtWhen = (t) => {
    if (!t) return '';
    const s = Date.now() / 1000 - t;
    if (s < 90) return 'à l’instant';
    if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
    const d = new Date(t * 1000), today = new Date();
    const same = d.toDateString() === today.toDateString();
    const yest = new Date(today - 86400000).toDateString() === d.toDateString();
    const hm = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return same ? `aujourd’hui, ${hm}` : yest ? `hier, ${hm}` : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' }) + `, ${hm}`;
  };
  const ROLE_PILL = { admin: 'accent', tech: 'info', viewer: '' };
  const rolePill = (r) => `<span class="pill ${ROLE_PILL[r] || ''}">${esc(ROLE_FR[r] || r)}</span>`;

  // ------------------------------------------------------------ confirmation simple (actions sur les comptes)
  function ask(title, text, yes = 'Confirmer', danger = false) {
    return new Promise((resolve) => {
      const d = $('#askDialog');
      $('#akTitle').textContent = title; $('#akText').textContent = text;
      const y = $('#akYes'); y.textContent = yes; y.className = `btn ${danger ? 'dangerous' : 'primary'}`;
      const done = (v) => { d.close(); y.onclick = $('#akNo').onclick = null; resolve(v); };
      y.onclick = () => done(true); $('#akNo').onclick = () => done(false);
      d.onclose = () => resolve(false);
      d.showModal(); $('#akNo').focus();
    });
  }

  // ------------------------------------------------------------ navigation
  const VIEWS = ['dashboard', 'users', 'roles', 'activity', 'profile'];
  const ADMIN_VIEWS = new Set(['users', 'activity']);
  const HASH = { 'tableau-de-bord': ['dashboard', 'top'], ports: ['dashboard', 'sec-facade'], alertes: ['dashboard', 'sec-alertes'],
    debit: ['dashboard', 'sec-debit'], journal: ['dashboard', 'sec-logs'], vlan: ['dashboard', 'sec-vlan'], outils: ['dashboard', 'sec-admin'],
    console: ['dashboard', 'sec-console'], utilisateurs: ['users'], roles: ['roles'], activite: ['activity'], profil: ['profile'] };
  let current = 'dashboard';
  const links = () => qsa('#sideNav a[data-view]');

  function mark(link) {
    links().forEach((a) => (a === link ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  }
  function show(view, { target = null, link = null, focus = false } = {}) {
    if (!VIEWS.includes(view)) view = 'dashboard';
    if (ADMIN_VIEWS.has(view) && !canAdmin()) view = 'dashboard';
    const changed = view !== current;
    current = view;
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
    mark(link || links().find((a) => a.dataset.view === view && (view !== 'dashboard' || a.dataset.target === (target || 'top'))));
    closeMenu();
    if (view === 'dashboard') {
      const el = target && target !== 'top' ? document.getElementById(target) : null;
      if (el && !el.hidden) el.scrollIntoView({ behavior: changed ? 'auto' : 'smooth', block: 'start' });
      else window.scrollTo({ top: 0, behavior: changed ? 'auto' : 'smooth' });
      if (changed && S) setTimeout(() => renderChart?.(), 0); // le graphique se redessine à la bonne largeur
    } else {
      window.scrollTo({ top: 0 });
      if (focus) $(`#view-${view} h2[tabindex]`)?.focus();
      LOAD[view]?.();
    }
  }
  window.NAV = { show, get current() { return current; } };

  $('#sideNav').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-view]');
    if (!a) return;
    e.preventDefault();
    history.replaceState(null, '', a.getAttribute('href'));
    show(a.dataset.view, { target: a.dataset.target, link: a, focus: true });
  });
  $('#need2faBanner a').addEventListener('click', (e) => { e.preventDefault(); history.replaceState(null, '', '#profil'); show('profile', { focus: true }); });
  $('#settingsBtn').addEventListener('click', () => closeMenu());

  // Section visible du tableau de bord : l'entrée correspondante du menu est mise en avant.
  const spy = 'IntersectionObserver' in window && new IntersectionObserver((entries) => {
    if (current !== 'dashboard') return;
    const vis = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!vis) return;
    const a = links().find((l) => l.dataset.target === vis.target.id);
    if (a) mark(a);
  }, { rootMargin: '-30% 0px -60% 0px' });
  ['top', 'sec-facade', 'sec-alertes', 'sec-debit', 'sec-logs', 'sec-vlan', 'sec-admin', 'sec-console'].forEach((id) => { const el = document.getElementById(id); if (el && spy) spy.observe(el); });
  // Tout en haut de la page : « Tableau de bord ».
  addEventListener('scroll', () => { if (current === 'dashboard' && scrollY < 60) mark(links().find((a) => a.dataset.target === 'top')); }, { passive: true });

  // Menu sur téléphone : panneau qui glisse, fermé par Échap, le fond ou le bouton.
  const openMenu = () => {
    document.body.classList.add('menu-open'); $('#sideScrim').hidden = false;
    $('#sideOpen').setAttribute('aria-expanded', 'true'); $('#sideClose').focus();
  };
  function closeMenu() {
    if (!document.body.classList.contains('menu-open')) return;
    document.body.classList.remove('menu-open'); $('#sideScrim').hidden = true;
    $('#sideOpen').setAttribute('aria-expanded', 'false');
  }
  $('#sideOpen').addEventListener('click', openMenu);
  $('#sideClose').addEventListener('click', () => { closeMenu(); $('#sideOpen').focus(); });
  $('#sideScrim').addEventListener('click', closeMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('menu-open')) { closeMenu(); $('#sideOpen').focus(); } });

  function fromHash() {
    const h = HASH[decodeURIComponent(location.hash.slice(1))];
    if (h) show(h[0], { target: h[1] });
  }
  addEventListener('hashchange', fromHash);

  // ------------------------------------------------------------ identité dans la barre latérale (à chaque lecture)
  let firstState = true, warned2fa = false;
  HOOK.poll.push((d) => {
    const me = d.me || ME;
    if (me) {
      $('#meName').textContent = me.name; $('#meRole').textContent = ROLE_FR[me.role] || '';
      $('#meAvatar').textContent = initials(me.name); $('#pfAvatar').textContent = initials(me.name);
    }
    $('#sideHost').textContent = S?.hostname || 'Switch';
    const pill = $('#agentPill');
    $('#sideSite').textContent = pill.lastElementChild?.textContent || '';
    $('#sideDot').className = `dot ${pill.classList.contains('ok') ? 'ok' : pill.classList.contains('ko') ? 'ko' : ''}`;
    $('#need2faBanner').hidden = !d.need2fa;
    if (d.need2fa && !warned2fa) { warned2fa = true; show('profile'); }
    if (!d.need2fa) warned2fa = false;
    if (firstState) { firstState = false; fromHash(); }
    if (ADMIN_VIEWS.has(current) && !canAdmin()) show('dashboard');
  });
  HOOK.role.push(() => { if (ADMIN_VIEWS.has(current) && !canAdmin()) show('dashboard'); });
  $('#sideVersion').textContent = `v${APP_VERSION}`;

  // ------------------------------------------------------------ mon profil
  let PROFILE = null, TOTP = null;
  async function loadProfile() {
    try {
      const d = await api('/api/settings?part=me');
      PROFILE = d.me; TOTP = d.totp;
      $('#pfName').value = PROFILE.name; $('#pfLogin').value = PROFILE.login; $('#pwUser').value = PROFILE.login;
      $('#pfEmail').value = PROFILE.email || ''; $('#pfAlerts').checked = PROFILE.prefs.alerts;
      $('#pfAlerts').disabled = !d.emailAvailable;
      $('#pfAlertsNote').textContent = d.emailAvailable ? 'Tu reçois les alertes activées dans Réglages, à l’adresse ci-dessus.' : 'Envoi d’e-mails indisponible : l’intégration Resend n’est pas activée sur Vercel.';
      $('#pfSub').textContent = `${ROLE_FR[PROFILE.role]} · compte créé ${PROFILE.created ? `le ${new Date(PROFILE.created * 1000).toLocaleDateString('fr-FR')}` : ''}`;
      $('#pfLast').textContent = PROFILE.lastLogin ? `${fmtWhen(PROFILE.lastLogin.t)} · ${PROFILE.lastLogin.ua}` : '-';
      $('#pwNote').textContent = PROFILE.owner && !PROFILE.ownPassword
        ? 'Tu utilises encore le mot de passe de secours défini dans Vercel (DASHBOARD_PASSWORD). Choisis ton propre mot de passe : celui de Vercel restera valable en secours.'
        : PROFILE.owner ? 'Le mot de passe de secours défini dans Vercel (DASHBOARD_PASSWORD) reste aussi valable pour ce compte.' : '';
      fillTotp(); syncTheme();
    } catch (err) { if (err.message !== '401') toast('Profil indisponible', { type: 'error', sub: err.message }); }
  }
  $('#pfForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('#pfName').value.trim()) { $('#pfName').setAttribute('aria-invalid', 'true'); $('#pfName').focus(); return toast('Indique un nom', { type: 'warn' }); }
    $('#pfName').removeAttribute('aria-invalid');
    busy($('#pfSave'), async () => {
      try {
        const d = await api('/api/settings', { action: 'profile-save', name: $('#pfName').value, email: $('#pfEmail').value, alerts: $('#pfAlerts').checked });
        PROFILE = d.me; ME = d.me; $('#meName').textContent = d.me.name; $('#meAvatar').textContent = $('#pfAvatar').textContent = initials(d.me.name);
        toast('Profil enregistré', { type: 'success' });
      } catch (err) { if (err.message !== '401') toast('Impossible d’enregistrer', { type: 'error', sub: err.message }); }
    });
  });
  $('#pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const a = $('#pwNew').value, b = $('#pwNew2').value;
    if (a.length < 10) { $('#pwNew').setAttribute('aria-invalid', 'true'); $('#pwNew').focus(); return toast('Mot de passe trop court', { type: 'warn', sub: '10 caractères au moins.' }); }
    if (a !== b) { $('#pwNew2').setAttribute('aria-invalid', 'true'); $('#pwNew2').focus(); return toast('Les deux mots de passe ne correspondent pas', { type: 'warn' }); }
    $('#pwNew').removeAttribute('aria-invalid'); $('#pwNew2').removeAttribute('aria-invalid');
    busy($('#pwSave'), async () => {
      try {
        await api('/api/settings', { action: 'profile-password', current: $('#pwCur').value, next: a });
        $('#pwForm').reset(); toast('Mot de passe changé', { type: 'success', sub: 'Tes autres appareils ont été déconnectés.' }); loadProfile();
      } catch (err) { if (err.message !== '401') { toast('Mot de passe non changé', { type: 'error', sub: err.message }); if (/actuel/.test(err.message)) $('#pwCur').select(); } }
    });
  });
  $('#pfLogoutOthers').addEventListener('click', async (e) => {
    if (!(await ask('Déconnecter tes autres appareils ?', 'Toutes tes sessions sauf celle-ci seront fermées.', 'Déconnecter', true))) return;
    busy(e.target, async () => {
      try { await api('/api/settings', { action: 'profile-logout-others' }); toast('Autres appareils déconnectés', { type: 'success' }); }
      catch (err) { if (err.message !== '401') toast('Échec', { type: 'error', sub: err.message }); }
    });
  });

  // Thème : clair, sombre ou automatique (suit l'ordinateur).
  function syncTheme() {
    const t = document.documentElement.dataset.theme || '';
    qsa('#pfTheme button').forEach((b) => { b.classList.toggle('on', b.dataset.t === t); b.setAttribute('aria-pressed', String(b.dataset.t === t)); });
  }
  $('#pfTheme').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.t) document.documentElement.dataset.theme = b.dataset.t; else delete document.documentElement.dataset.theme;
    try { if (b.dataset.t) localStorage.setItem('theme', b.dataset.t); else localStorage.removeItem('theme'); } catch {}
    labelTheme(); syncTheme(); if (S) renderChart();
  });
  $('#themeBtn').addEventListener('click', () => setTimeout(syncTheme, 0));

  // Double authentification du compte connecté.
  function fillTotp() {
    const on = Boolean(TOTP?.enabled);
    const since = TOTP?.t ? new Date(TOTP.t * 1000).toLocaleDateString('fr-FR') : '';
    $('#tfPill').className = `pill ${on ? 'good' : PROFILE?.require2fa ? 'warn' : ''}`;
    $('#tfPill').textContent = on ? 'Activée' : PROFILE?.require2fa ? 'Exigée' : 'Désactivée';
    $('#tfNote').textContent = on ? `Activée depuis le ${since}. Codes de secours restants : ${TOTP.recoveryLeft}.`
      : PROFILE?.require2fa ? 'Un administrateur l’exige pour ton compte : active-la pour pouvoir agir sur le switch.'
        : 'Recommandé : un code à 6 chiffres d’une application, en plus du mot de passe, à chaque connexion.';
    $('#tfOn').hidden = !on; $('#tfStart').hidden = on || !$('#tfSetup').hidden;
    $('#tfOff').hidden = Boolean(PROFILE?.require2fa);
    if (on) $('#tfSetup').hidden = true;
  }
  const loadQr = () => (window.qrcode ? Promise.resolve() : new Promise((ok, ko) => {
    const sc = document.createElement('script'); sc.src = '/vendor/qrcode.js'; sc.onload = ok; sc.onerror = () => ko(new Error('QR code indisponible')); document.head.append(sc);
  }));
  function showCodes(list) {
    $('#tfList').textContent = list.join('\n'); $('#tfCodes').hidden = false;
    $('#tfDownload').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([`My Aruba Manager : codes de secours de ${PROFILE?.login || ''} (${new Date().toLocaleString('fr-FR')})\n\n${list.join('\n')}\n`], { type: 'text/plain' }));
      a.download = 'my-aruba-manager-codes-de-secours.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
  }
  const totpCall = (action, extra = {}) => api('/api/settings', { action, ...extra });
  $('#tfStart').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const d = await totpCall('totp-start');
      await loadQr();
      const qr = window.qrcode(0, 'M'); qr.addData(d.uri); qr.make();
      $('#tfQr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); // SVG généré localement, sans donnée tierce
      $('#tfSecret').textContent = d.secret.replace(/(.{4})/g, '$1 ').trim();
      $('#tfSetup').hidden = false; $('#tfStart').hidden = true; $('#tfCode').value = ''; $('#tfCode').focus();
    } catch (err) { toast('Activation impossible', { type: 'error', sub: err.message }); }
  }));
  $('#tfConfirm').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try {
      const d = await totpCall('totp-confirm', { code: $('#tfCode').value });
      TOTP = d.totp; $('#tfSetup').hidden = true; showCodes(d.recovery); fillTotp();
      toast('Double authentification activée', { type: 'success', sub: 'Le code de l’application sera demandé à chaque connexion.' });
      setTimeout(poll, 300); // le bandeau « exigée » disparaît
    } catch (err) { toast('Code refusé', { type: 'error', sub: err.message }); $('#tfCode').select(); }
  }));
  $('#tfCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#tfConfirm').click(); } });
  $('#tfNew').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    try { const d = await totpCall('totp-recovery', { code: $('#tfCur').value }); TOTP = d.totp; $('#tfCur').value = ''; showCodes(d.recovery); fillTotp(); }
    catch (err) { toast('Code refusé', { type: 'error', sub: err.message }); }
  }));
  $('#tfOff').addEventListener('click', async (e) => {
    if (!$('#tfCur').value.trim()) { $('#tfCur').focus(); return toast('Saisis d’abord un code', { type: 'warn', sub: 'Code actuel de l’application ou code de secours.' }); }
    if (!(await ask('Désactiver la double authentification ?', 'Le mot de passe seul suffira de nouveau pour se connecter à ce compte.', 'Désactiver', true))) return;
    busy(e.target, async () => {
      try {
        const d = await totpCall('totp-disable', { code: $('#tfCur').value }); TOTP = d.totp; $('#tfCur').value = ''; $('#tfCodes').hidden = true; fillTotp();
        toast('Double authentification désactivée', { type: 'warn' });
      } catch (err) { toast('Code refusé', { type: 'error', sub: err.message }); }
    });
  });

  // ------------------------------------------------------------ utilisateurs
  let USERS = [], USER_FILTER = 'all', EMAIL_OK = false, MY_ID = null, editing = null;
  async function loadUsers() {
    if (!canAdmin()) return;
    try {
      const d = await api('/api/settings?part=users');
      USERS = d.users; EMAIL_OK = d.emailAvailable; MY_ID = d.me;
      renderUsers();
    } catch (err) { if (err.message !== '401') setHTML($('#userRows'), `<tr><td colspan="6"><div class="empty">${esc(err.message)}</div></td></tr>`); }
  }
  function stateOf(u) {
    if (u.disabled) return '<span class="pill bad">Désactivé</span>';
    if (u.pending) return `<span class="pill warn">Invité</span>${u.invite ? `<small>lien valable jusqu’au ${esc(new Date(u.invite.exp * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</small>` : '<small>lien expiré</small>'}`;
    return '<span class="pill good">Actif</span>';
  }
  function renderUsers() {
    const q = $('#userSearch').value.trim().toLowerCase();
    const list = USERS.filter((u) => (USER_FILTER === 'all' || (USER_FILTER === 'active' && !u.disabled && !u.pending) || (USER_FILTER === 'pending' && u.pending) || (USER_FILTER === 'off' && u.disabled))
      && (!q || `${u.name} ${u.login} ${u.email}`.toLowerCase().includes(q)));
    setHTML($('#userRows'), list.length ? list.map((u) => `<tr>
      <td><div class="u-cell"><span class="avatar${u.id === MY_ID ? ' me' : ''}" aria-hidden="true">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b>${u.id === MY_ID ? ' <span class="muted">(toi)</span>' : ''}${u.owner ? ' <span class="badge">principal</span>' : ''}<small>${esc(u.login)}</small></div></div></td>
      <td>${rolePill(u.role)}</td>
      <td>${u.has2fa ? '<span class="pill good">Activée</span>' : u.require2fa ? '<span class="pill warn">Exigée</span>' : u.role === 'viewer' ? '<span class="muted">facultative</span>' : '<span class="muted">non activée</span>'}</td>
      <td>${u.lastLogin ? `${esc(fmtWhen(u.lastLogin.t))}<small>${esc(u.lastLogin.ua)}</small>` : '<span class="muted">jamais</span>'}</td>
      <td>${stateOf(u)}</td>
      <td class="r">${u.id === MY_ID ? '<a class="btn small" href="#profil" data-go-profile>Mon profil</a>' : `<button type="button" class="btn small" data-edit="${esc(u.id)}" aria-label="Gérer ${esc(u.name)}">Gérer</button>`}</td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty">${USERS.length ? 'Aucun compte ne correspond.' : 'Aucun compte.'}</div></td></tr>`);
    const now = Date.now() / 1000, on = USERS.filter((u) => u.seen && now - u.seen.t < 180);
    $('#onlineCount').textContent = on.length ? String(on.length) : '';
    setHTML($('#onlineList'), on.length ? on.map((u) => `<div class="alert-item" style="grid-template-columns:32px 1fr auto"><span class="avatar" aria-hidden="true">${esc(initials(u.name))}</span>
      <div><b>${esc(u.name)}</b> ${rolePill(u.role)}<div class="ch">${esc(u.seen.ua || '')}</div></div><span class="when">${esc(fmtWhen(u.seen.t))}</span></div>`).join('')
      : '<div class="empty" style="padding:12px 0">Personne d’autre en ce moment.</div>');
  }
  $('#userSearch').addEventListener('input', renderUsers);
  $('#userFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    USER_FILTER = b.dataset.f;
    qsa('#userFilter button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderUsers();
  });
  $('#userRows').addEventListener('click', (e) => {
    if (e.target.closest('[data-go-profile]')) { e.preventDefault(); history.replaceState(null, '', '#profil'); return show('profile', { focus: true }); }
    const b = e.target.closest('[data-edit]'); if (b) openUser(USERS.find((u) => u.id === b.dataset.edit));
  });

  const roleInput = (v) => $(`#udRoles input[value="${v}"]`);
  function syncUserForm() {
    const role = $('#udRoles input:checked')?.value;
    $('#ud2faRow').hidden = role === 'viewer';
    $('#udPwRow').hidden = $('input[name="udMode"]:checked').value !== 'password';
  }
  $('#userForm').addEventListener('change', syncUserForm);
  function openUser(u = null) {
    editing = u;
    const f = $('#userForm'); f.reset(); $('#udErr').textContent = '';
    qsa('#userForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    $('#udTitle').textContent = u ? `Gérer ${u.name}` : 'Nouvel utilisateur';
    $('#udSave').textContent = u ? 'Enregistrer' : 'Créer le compte';
    $('#udName').value = u?.name || ''; $('#udLogin').value = u?.login || '';
    $('#udLogin').readOnly = Boolean(u?.owner);
    roleInput(u?.role || 'tech').checked = true;
    qsa('#udRoles input').forEach((x) => { x.disabled = Boolean(u?.owner); });
    $('#ud2fa').checked = u ? u.require2fa : true;
    $('#udModeRow').hidden = Boolean(u);
    $('#udManage').hidden = !u;
    if (u) {
      $('#udReset').textContent = u.pending ? 'Renvoyer l’invitation' : 'Lien de nouveau mot de passe';
      $('#ud2faReset').hidden = !u.has2fa;
      $('#udDisable').hidden = u.disabled || u.owner; $('#udEnable').hidden = !u.disabled; $('#udDelete').hidden = u.owner;
    }
    syncUserForm();
    $('#userDialog').showModal(); $('#udName').focus();
  }
  $('#userNew').addEventListener('click', () => openUser());
  $('#udCancel').addEventListener('click', () => $('#userDialog').close());
  $('#userForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#udName').value.trim(), login = $('#udLogin').value.trim(), role = $('#udRoles input:checked')?.value;
    const mode = $('input[name="udMode"]:checked').value, pw = $('#udPw').value;
    const bad = (el, msg) => { el.setAttribute('aria-invalid', 'true'); el.focus(); $('#udErr').textContent = msg; };
    qsa('#userForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    if (!name) return bad($('#udName'), 'Indique un nom.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._@+-]{1,63}$/.test(login)) return bad($('#udLogin'), 'Identifiant invalide : lettres, chiffres, point, tiret, ou une adresse e-mail.');
    if (!editing && mode === 'password' && pw.length < 10) return bad($('#udPw'), 'Le mot de passe doit faire au moins 10 caractères.');
    $('#udErr').textContent = '';
    busy($('#udSave'), async () => {
      try {
        if (editing) {
          await api('/api/settings', { action: 'user-update', id: editing.id, name, login, role, require2fa: $('#ud2fa').checked });
          $('#userDialog').close(); toast('Compte enregistré', { type: 'success' });
        } else {
          const d = await api('/api/settings', { action: 'user-create', name, login, role, require2fa: $('#ud2fa').checked, mode, password: pw });
          $('#userDialog').close();
          if (d.link) showLink(d.user, d.link, d.mailed, 'invite');
          else toast('Compte créé', { type: 'success', sub: `Identifiant : ${d.user.login}` });
        }
        loadUsers();
      } catch (err) { if (err.message !== '401') $('#udErr').textContent = err.message; }
    });
  });
  const CONFIRM = {
    'user-disable': (u) => ['Désactiver ce compte ?', `${u.name} sera déconnecté tout de suite et ne pourra plus se connecter. Tu pourras le réactiver.`, 'Désactiver', true],
    'user-delete': (u) => ['Supprimer ce compte ?', `${u.name} sera supprimé définitivement. Ses actions restent dans le journal d’activité.`, 'Supprimer', true],
    'user-logout': (u) => ['Fermer ses sessions ?', `${u.name} devra se reconnecter sur tous ses appareils.`, 'Fermer les sessions', false],
    'user-2fa-reset': (u) => ['Réinitialiser sa double authentification ?', `À utiliser si ${u.name} a perdu son téléphone et ses codes de secours. Il devra la réactiver${u.require2fa ? ' (elle reste exigée)' : ''}.`, 'Réinitialiser', true],
  };
  $('#udManage').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ua]'); if (!b || !editing) return;
    const action = b.dataset.ua, u = editing;
    if (CONFIRM[action] && !(await ask(...CONFIRM[action](u)))) return;
    busy(b, async () => {
      try {
        const d = await api('/api/settings', { action, id: u.id });
        $('#userDialog').close();
        if (d.link) showLink(u, d.link, d.mailed, u.pending ? 'invite' : 'reset');
        else toast({ 'user-disable': 'Compte désactivé', 'user-enable': 'Compte réactivé', 'user-delete': 'Compte supprimé', 'user-logout': 'Sessions fermées', 'user-2fa-reset': 'Double authentification réinitialisée' }[action] || 'Fait', { type: 'success' });
        loadUsers();
      } catch (err) { if (err.message !== '401') $('#udErr').textContent = err.message; }
    });
  });
  function showLink(u, link, mailed, kind) {
    $('#lkTitle').textContent = kind === 'invite' ? 'Lien d’invitation' : 'Lien de nouveau mot de passe';
    $('#lkText').textContent = `${mailed ? `Envoyé par e-mail à ${u.email || u.login}. ` : ''}Lien pour ${u.name}, valable 48 h.`;
    $('#lkUrl').value = link;
    $('#linkDialog').showModal(); $('#lkUrl').select();
  }
  $('#lkCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#lkUrl').value); toast('Lien copié', { type: 'success', timeout: 2000 }); }
    catch { $('#lkUrl').select(); toast('Copie impossible', { type: 'warn', sub: 'Le lien est sélectionné : Ctrl+C ou Cmd+C.' }); }
  });
  $('#lkClose').addEventListener('click', () => { $('#lkUrl').value = ''; $('#linkDialog').close(); });
  $('#linkDialog').addEventListener('close', () => { $('#lkUrl').value = ''; });

  // ------------------------------------------------------------ journal d'activité
  let AUDIT = [];
  async function loadAudit() {
    if (!canAdmin()) return;
    try { AUDIT = (await api('/api/settings?part=audit')).rows || []; renderAudit(); }
    catch (err) { if (err.message !== '401') setHTML($('#auditRows'), `<tr><td colspan="4"><div class="empty">${esc(err.message)}</div></td></tr>`); }
  }
  const auditFiltered = () => { const q = $('#auditSearch').value.trim().toLowerCase(); return AUDIT.filter((a) => !q || `${a.who} ${a.action} ${a.detail}`.toLowerCase().includes(q)); };
  function renderAudit() {
    const rows = auditFiltered().slice(0, 300);
    setHTML($('#auditRows'), rows.length ? rows.map((a) => `<tr>
      <td class="num" style="white-space:nowrap">${esc(new Date(a.t * 1000).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
      <td>${esc(a.who)}${a.ua ? `<small>${esc(a.ua)}</small>` : ''}</td>
      <td>${/refusée/.test(a.action) ? `<span class="pill bad">${esc(a.action)}</span>` : esc(a.action)}</td>
      <td class="muted">${esc(a.detail)}</td></tr>`).join('')
      : `<tr><td colspan="4"><div class="empty">${AUDIT.length ? 'Aucune entrée ne correspond.' : 'Rien pour l’instant.'}</div></td></tr>`);
  }
  $('#auditSearch').addEventListener('input', renderAudit);
  $('#auditRefresh').addEventListener('click', (e) => busy(e.currentTarget, loadAudit));
  $('#auditCsv').addEventListener('click', () => {
    // Cellules protégées contre l'injection de formules (=, +, -, @ en tête) à l'ouverture dans un tableur.
    const cell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
    const lines = [['Date', 'Qui', 'Appareil', 'Action', 'Détail'].map(cell).join(';'),
      ...auditFiltered().map((a) => [new Date(a.t * 1000).toLocaleString('fr-FR'), a.who, a.ua, a.action, a.detail].map(cell).join(';'))];
    const url = URL.createObjectURL(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `journal-activite-${new Date().toISOString().slice(0, 10)}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  const LOAD = { users: loadUsers, activity: loadAudit, profile: loadProfile };
  // Les pages ouvertes se rafraîchissent toutes seules (comptes en ligne, nouvelles entrées du journal).
  setInterval(() => { if (!document.hidden && !$('#app').hidden && (current === 'users' || current === 'activity')) LOAD[current](); }, 30000);

  // ------------------------------------------------------------ connexion : identifiant mémorisé, liens d'invitation
  try { const l = localStorage.getItem('lastLogin'); if (l) $('#loginId').value = l; } catch {}
  const token = new URLSearchParams(location.search).get('invite');
  if (token) {
    $('#loginForm').hidden = true; $('#inviteForm').hidden = false;
    api('/api/login', { action: 'invite-info', token }).then((d) => {
      $('#ivTitle').textContent = d.kind === 'invite' ? `Bienvenue ${d.name}` : `Nouveau mot de passe`;
      $('#ivText').textContent = d.kind === 'invite' ? `Un compte ${String(d.role).toLowerCase()} t’attend. Choisis ton mot de passe.` : `Choisis un nouveau mot de passe pour ${d.name}.`;
      $('#ivLogin').value = d.login; $('#ivPw').focus();
    }).catch((err) => {
      $('#ivTitle').textContent = 'Lien invalide';
      $('#ivText').textContent = err.message;
      qsa('#inviteForm .field, #ivBtn').forEach((x) => { x.hidden = true; });
      const back = document.createElement('a'); back.href = '/'; back.className = 'btn'; back.textContent = 'Aller à la connexion';
      $('#inviteForm').append(back);
    });
  }
  $('#inviteForm').addEventListener('submit', (e) => {
    e.preventDefault(); $('#ivErr').textContent = '';
    const a = $('#ivPw').value, b = $('#ivPw2').value;
    if (a.length < 10) { $('#ivErr').textContent = 'Le mot de passe doit faire au moins 10 caractères.'; return $('#ivPw').focus(); }
    if (a !== b) { $('#ivErr').textContent = 'Les deux mots de passe ne correspondent pas.'; return $('#ivPw2').focus(); }
    busy($('#ivBtn'), async () => {
      try {
        const d = await api('/api/login', { action: 'invite-accept', token, password: a });
        history.replaceState(null, '', '/');
        $('#inviteForm').hidden = true; $('#loginForm').hidden = false; $('#ivPw').value = $('#ivPw2').value = '';
        if (d.needLogin) { $('#loginId').value = d.login; $('#pw').focus(); return toast('Mot de passe enregistré', { type: 'success', sub: 'Connecte-toi maintenant, avec ton code de double authentification.' }); }
        try { localStorage.setItem('lastLogin', $('#ivLogin').value); } catch {}
        showApp(); loadSettings(); poll();
        toast('Bienvenue', { type: 'success', sub: d.need2fa ? 'Active maintenant la double authentification, demandée par l’administrateur.' : 'Ton compte est prêt.' });
      } catch (err) { $('#ivErr').textContent = err.message; $('#ivErr').focus(); }
    });
  });
})();
