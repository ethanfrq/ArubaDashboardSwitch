// Démarrage : accompagner une nouvelle installation et chaque nouveau compte.
//   Avant connexion (état renvoyé par /api/state, HOOK.login) : écran « Installation à terminer » quand la base ou une
//   variable Vercel manque, encadré « Première connexion » sur une installation neuve ; les deux ouvrent la présentation
//   en vidéo (liens [data-video]).
//   Administrateur : assistant de démarrage en 8 étapes (vue #view-setup, ancre #demarrage), vérifiées en direct par
//   GET /api/settings?part=setup ; il s'ouvre tout seul tant qu'il n'est ni terminé ni remis à plus tard.
//   Nouveau compte : fenêtre de bienvenue (vidéo, ce que permet son rôle), une seule fois (prefs.welcomed).
// Utilise app.js ($, api, esc, toast, busy, setHTML, ago, arr, canAdmin, ROLE, ROLE_FR, ME, S, NOW, SETUP, HOOK,
// ADMIN, openAlertSettings, poll) et account.js (NAV.show). Fourni : ADMIN.setupOpen(), appelé à l'ouverture de la vue.
// Rien de secret n'est affiché : le jeton de l'agent ne passe que dans le fichier téléchargé, jamais dans la page.
(() => {
  'use strict';
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const RELEASES = 'https://github.com/ethanfrq/ArubaDashboardSwitch/releases/latest';
  const PYTHON = 'https://www.python.org/downloads/windows/';
  const VIDEO = '/media/my-aruba-manager.mp4', POSTER = '/media/apercu.jpg';
  const CFG_KEY = 'mam-agent-config'; // agent_config.json déjà téléchargé depuis ce navigateur (confort d'affichage)
  const STEP_KEY = 'mam-setup-step'; // dernière étape ouverte
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const local = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };
  const plural = (n, s, p = `${s}s`) => (n > 1 ? p : s);
  const fmtDate = (t) => new Date((t > 1e12 ? t : t * 1000)).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const say = (msg) => { const el = $('#obSay'); el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 50); }; // annonce aux lecteurs d'écran

  // ---------------------------------------------------------------- icônes et petits blocs
  // Icônes Google Material Symbols (public/js/icons.js), taille réglée par la classe ob-svg selon l'endroit.
  const ic = (name) => icon(name, { size: 16, cls: 'ob-svg' });
  const IC = {
    ok: ic('check'), ko: ic('close'), wait: ic('hourglass_top'), todo: ic('radio_button_unchecked'), opt: ic('do_not_disturb_on'),
    play: ic('play_arrow'), copy: ic('content_copy'), ext: ic('open_in_new'), down: ic('download'), warn: ic('warning'),
    info: ic('info'), zoom: ic('open_in_full'),
  };
  // Statuts : toujours une icône et un texte, jamais la couleur seule.
  const ST = { ok: ['Fait', 'good'], todo: ['À faire', ''], wait: ['En attente', 'warn'], ko: ['À corriger', 'bad'], opt: ['Facultatif', 'info'] };
  const pill = (st, label = ST[st][0]) => `<span class="pill ob-pill ${ST[st][1]}">${IC[st]}${esc(label)}</span>`;
  // Ligne de vérification : icône, titre (nom de variable en police fixe si mono), détail, statut en texte, bouton éventuel.
  const chk = (st, title, detail, label, acts = '', mono = false) => `<li class="ob-chk ${st}"><span class="ob-ci" aria-hidden="true">${IC[st]}</span>
    <div><b${mono ? ' class="mono"' : ''}>${esc(title)}</b><p>${esc(detail)}</p></div><span class="acts">${acts}${pill(st, label)}</span></li>`;
  const checking = () => chk('wait', 'Vérification en cours…', 'Lecture de l’état de l’installation.', 'En attente');
  // Illustration : ouverte en grand (nouvel onglet) d'un clic, avec un repère visible « Agrandir l'image ».
  const fig = (name, alt, cap = '', cls = '') => `<figure class="ob-fig ${cls}"><a href="/onboarding/${name}.svg" target="_blank" rel="noopener"><img src="/onboarding/${name}.svg" width="720" height="400" loading="lazy" decoding="async" alt="${esc(alt)}"><span class="ob-zoom">${IC.zoom}Agrandir l’image<span class="sr"> (nouvel onglet)</span></span></a>${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`;
  const cmd = (lines, label) => `<div class="ob-cmd"><pre>${esc(lines.join('\n'))}</pre><button type="button" class="btn small" data-copy aria-label="${esc(label)}">${IC.copy}<span>Copier</span></button></div>`;
  const VIDEO_SUMMARY = [
    'La façade du switch en direct : l’état et le débit de chaque port.',
    'Qui est branché où : nom, adresse IP et adresse MAC de chaque appareil.',
    'Un câble défectueux testé paire par paire, en un clic.',
    'Les VLAN, la console de gestion et les alertes par e-mail ou webhook.',
    'Le principe : hébergé sur Vercel, sans ouvrir un seul port sur ton réseau.',
  ];
  const vsum = () => VIDEO_SUMMARY.map((t) => `<li>${esc(t)}</li>`).join('');
  qsa('[data-vsum]').forEach((ul) => { ul.innerHTML = vsum(); });

  // Vidéo : lecture automatique (en muet) seulement si la personne n'a pas demandé de réduire les animations.
  function autoplay(v) {
    if (!v || reduced()) return;
    v.muted = true;
    const p = v.play();
    if (p?.catch) p.catch(() => {});
  }
  // Une illustration absente (fichier pas encore publié) disparaît au lieu d'afficher une image cassée.
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img?.tagName === 'IMG' && img.closest('.ob-fig')) img.closest('.ob-fig').hidden = true;
  }, true);

  // ---------------------------------------------------------------- copier (presse-papiers, avec repli)
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.className = 'sr';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const pre = b.closest('.ob-cmd')?.querySelector('pre'); if (!pre) return;
    if (await copyText(pre.textContent)) {
      const label = b.lastElementChild;
      label.textContent = 'Copié'; say('Copié dans le presse-papiers.');
      clearTimeout(b._t); b._t = setTimeout(() => { label.textContent = 'Copier'; }, 2000);
    } else {
      const r = document.createRange(); r.selectNodeContents(pre);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('Copie impossible', { type: 'warn', sub: 'Le texte est sélectionné : Ctrl+C (ou Cmd+C) pour le copier.' });
    }
  });

  // ================================================================ avant connexion
  const ENV_INFO = {
    DASHBOARD_PASSWORD: 'Mot de passe du compte admin pour la première connexion, choisi par toi.',
    SESSION_SECRET: 'Clé secrète qui signe les sessions : une longue valeur aléatoire.',
    AGENT_TOKEN: 'Jeton que l’agent présente au dashboard : une longue valeur aléatoire.',
  };
  const DB_VARS = ['POSTGRES_URL', 'DATABASE_URL', 'SUPABASE_DB_URL'];
  let forceLogin = false, preFocused = false;
  const inviteLink = () => new URLSearchParams(location.search).has('invite');

  function renderPre(setup) {
    const invite = inviteLink();
    const incomplete = Boolean(setup) && setup.ok === false && !forceLogin && !invite;
    $('#installCard').hidden = !incomplete;
    if (!invite) $('#loginForm').hidden = incomplete;
    const fresh = Boolean(setup?.fresh) && !incomplete && !invite;
    $('#firstBox').hidden = !fresh;
    if (fresh && !$('#loginId').value) {
      $('#loginId').value = 'admin';
      // app.js a pu placer le focus sur l'identifiant juste avant (état reçu avant ce fichier) : on passe au mot de passe.
      if (document.activeElement === $('#loginId')) $('#pw').focus();
    }
    if (!incomplete) return;
    fillInstall(setup);
    if (!preFocused) { preFocused = true; $('#instTitle').focus(); }
  }

  function fillInstall(setup) {
    const miss = arr(setup.missing).map(String);
    const envMiss = miss.filter((v) => !DB_VARS.includes(v));
    const noDb = miss.some((v) => DB_VARS.includes(v));
    const rows = [chk(setup.db ? 'ok' : 'ko', 'Base de données',
      setup.db ? 'Supabase répond.' : noDb ? 'Aucune base n’est encore reliée au projet.' : 'La base est reliée, mais elle ne répond pas.',
      setup.db ? 'OK' : noDb ? 'Absente' : 'Injoignable')];
    for (const name of [...Object.keys(ENV_INFO), ...envMiss.filter((v) => !ENV_INFO[v])]) {
      const ko = envMiss.includes(name);
      rows.push(chk(ko ? 'ko' : 'ok', name, ENV_INFO[name] || 'Variable d’environnement obligatoire.', ko ? 'Manquante' : 'OK', '', true));
    }
    setHTML($('#instList'), rows.join(''));
    const n = envMiss.length + (setup.db ? 0 : 1);
    $('#instCount').textContent = `${n} ${plural(n, 'point')} à corriger.`;
    $('#instEnv').hidden = !envMiss.length;
    $('#instEnvNames').textContent = envMiss.join(', ');
    $('#instDb').hidden = Boolean(setup.db);
    $('#instDbAdd').hidden = !noDb; $('#instDbDown').hidden = noDb;
  }

  HOOK.login.push(renderPre);
  if (SETUP && !$('#login').hidden) renderPre(SETUP); // état reçu avant le chargement de ce fichier

  $('#instRecheck').addEventListener('click', (e) => busy(e.currentTarget, async () => {
    await poll();
    if (!$('#installCard').hidden) toast('Installation toujours incomplète', { type: 'warn', sub: `${$('#instCount').textContent} As-tu redéployé le projet après tes changements ?`, timeout: 8000 });
    else if (!$('#login').hidden) toast('Installation complète', { type: 'success', sub: 'Tu peux te connecter.' });
  }));
  $('#instSkip').addEventListener('click', () => { forceLogin = true; renderPre(SETUP); $('#loginId').focus(); });

  // Présentation en vidéo (fenêtre) : tout lien [data-video] (Installation à terminer, Première connexion). À la
  // fermeture, le focus revient au lien qui l'a ouverte.
  let vidOpener = null;
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-video]'); if (!a) return;
    e.preventDefault();
    vidOpener = a;
    $('#videoDialog').showModal();
    autoplay($('#vidPlayer'));
  });
  $('#vidClose').addEventListener('click', () => $('#videoDialog').close());
  $('#videoDialog').addEventListener('close', () => {
    $('#vidPlayer').pause();
    const a = vidOpener; vidOpener = null;
    if (a?.isConnected && a.getClientRects().length) a.focus();
  });

  // ================================================================ assistant de démarrage (administrateur)
  let SD = null, sdErr = '', sdAt = 0, loading = null, step = null, rendered = -1, played = false;
  const CFG = { host: '', user: 'admin', net: '' }; // champs de l'étape 5, gardés quand on change d'étape
  const K = () => SD?.checks || {};
  const agentOk = () => Boolean(K().agent?.ok);
  const cfgSaved = () => Boolean(local.get(CFG_KEY));
  const download = () => (/^https:\/\//.test(SD?.agentDownload || '') ? SD.agentDownload : RELEASES);
  const autoNote = '<p class="ob-auto">' + IC.info + 'Cette étape se coche toute seule quand l’agent est connecté.</p>';

  const STEPS = [
    { title: 'Bienvenue', sub: 'Vidéo et principe',
      view: () => `<p class="ob-lead">Regarde d’abord la présentation, puis laisse-toi guider : en 20 minutes environ, ton switch apparaît dans le dashboard.</p>
        <div class="ob-video big"><video id="obPlayer" controls playsinline muted preload="metadata" poster="${POSTER}" aria-describedby="obSum"><source src="${VIDEO}" type="video/mp4"><a href="${VIDEO}">Télécharger la vidéo</a></video></div>
        <div class="ob-cols">
          <div><h4>Dans la vidéo (30 s, sans son)</h4><ul class="ob-list" id="obSum">${vsum()}</ul></div>
          <div><h4>Ce qu’il te faut</h4><ul class="ob-list"><li>Un switch Aruba CX joignable en SSH, avec son compte et son mot de passe</li>
            <li>Un PC Windows allumé en permanence, sur le même réseau que le switch</li><li>Les droits d’administrateur sur ce PC</li><li>Environ 20 minutes</li></ul></div>
        </div>`,
      // Après les boutons : le schéma d'ensemble, en complément (« Commencer » reste près de la vidéo).
      after: () => `<div class="ob-sec">${fig('architecture', 'Schéma : le switch Aruba est relié en SSH au PC de l’agent, sur le réseau local. L’agent envoie l’état du switch en HTTPS sortant vers Vercel (dashboard et API), qui range les données dans Supabase. Ton navigateur ouvre le dashboard sur Vercel, où que tu sois.',
          'L’agent lit le switch en SSH et envoie son état en HTTPS sortant : aucun port à ouvrir sur ta box ou ton pare-feu.', 'wide')}</div>`,
      mount: () => { if (!played) { played = true; autoplay($('#obPlayer')); } } },

    { title: 'Installation', sub: 'Base, variables, vérification',
      status: () => (K().db?.ok && K().env?.ok && K().cron?.ok ? 'ok' : 'ko'),
      view: () => `<p class="ob-lead">Le dashboard vérifie sa propre installation sur Vercel et Supabase.</p>
        <ul class="ob-checks" id="obInst" aria-label="État de l’installation"></ul>
        <div class="ob-acts"><button type="button" class="btn" data-ob="recheck" data-main id="obRecheck">Revérifier</button></div>
        <div class="ob-sec" id="obInstEnv" hidden><div class="ob-row"><div><h4>Ajoute les variables manquantes</h4>
          <ol class="ob-ol"><li>Sur vercel.com, ouvre ton projet, puis <b>Settings</b> et <b>Environment Variables</b>.</li>
            <li>Ajoute <b id="obInstEnvNames"></b> pour tous les environnements (<b>All Environments</b>, ou au moins <b>Production</b>).</li>
            <li>Redéploie le projet : <b>Deployments</b>, <b>${icon('more_horiz', { size: 16, label: 'trois points' })}</b>, <b>Redeploy</b>.</li></ol></div>
          ${fig('vercel-env', 'Vercel : Settings, puis Environment Variables, avec DASHBOARD_PASSWORD, SESSION_SECRET et AGENT_TOKEN (valeurs masquées).', 'Settings, Environment Variables : une ligne par variable.')}</div></div>
        <div class="ob-sec" id="obInstCron" hidden><div class="ob-row"><div><h4>Active la vérification automatique</h4>
          <p>Sans elle, l’alerte « agent hors ligne », les actions planifiées et les sauvegardes automatiques ne fonctionnent pas.</p>
          <ol class="ob-ol"><li>Sur supabase.com, ouvre ton projet, puis <b>Database</b> et <b>Extensions</b>.</li>
            <li>Active <b>pg_cron</b> et <b>pg_net</b>.</li><li>Reviens ici et clique sur <b>Revérifier</b>.</li></ol></div>
          ${fig('supabase-extensions', 'Supabase : Database, Extensions, avec pg_cron et pg_net activés.', 'Database, Extensions : pg_cron et pg_net activés.')}</div></div>`,
      live: () => {
        const k = K(), env = k.env || {}, cron = k.cron || {}, st = status(1);
        setFocused($('#obInst'), !SD ? checking() : [
          chk(k.db?.ok ? 'ok' : 'ko', 'Base de données', k.db?.ok ? 'Supabase répond.' : 'La base ne répond pas.', k.db?.ok ? 'OK' : 'À corriger'),
          chk(env.ok ? 'ok' : 'ko', 'Variables de Vercel', env.ok ? 'SESSION_SECRET, AGENT_TOKEN et DASHBOARD_PASSWORD sont définies.' : `Manquantes : ${arr(env.missing).join(', ')}.`, env.ok ? 'OK' : 'À corriger'),
          chk(cron.ok ? 'ok' : 'ko', 'Vérification automatique (toutes les 5 min)',
            cron.local ? 'Pas utilisée en développement local : rien à faire.' : cron.ok ? 'Programmée dans Supabase.' : `Pas programmée${cron.error ? ` : ${cron.error}` : ''}.`,
            cron.ok ? (cron.local ? 'Local' : 'OK') : 'À corriger'),
        ].join(''));
        $('#obInstEnv').hidden = !SD || Boolean(env.ok);
        $('#obInstEnvNames').textContent = arr(env.missing).join(', ');
        $('#obInstCron').hidden = !SD || Boolean(cron.ok);
        $('#obRecheck').hidden = Boolean(SD) && st === 'ok';
      } },

    { title: 'Sécuriser ton compte', sub: 'Mot de passe, double auth.',
      status: () => (K().password?.ok && K().twofa?.ok ? 'ok' : 'todo'),
      view: () => `<p class="ob-lead">Ton compte peut tout faire sur le switch : protège-le avant d’aller plus loin.</p>
        <div class="ob-row"><div><ul class="ob-checks" id="obSecure" aria-label="Sécurité de ton compte"></ul>
          <p class="note" style="margin-top:12px">Garde les codes de secours affichés à l’activation : ils servent si tu perds ton téléphone.</p></div>
          ${fig('phone-2fa', 'Mon profil affiche un QR code ; l’application d’authentification du téléphone affiche un code à 6 chiffres.', 'Scanne le QR code de « Mon profil » avec une application d’authentification, puis saisis le code à 6 chiffres.')}</div>`,
      live: () => {
        const k = K(), pw = Boolean(k.password?.ok), tf = Boolean(k.twofa?.ok);
        const main = !pw ? 'go-pw' : !tf ? 'go-2fa' : '';
        const btn = (act, label) => `<button type="button" class="btn small" data-ob="${act}"${main === act ? ' data-main' : ''}>${label}</button>`;
        setFocused($('#obSecure'), !SD ? checking() : [
          chk(pw ? 'ok' : 'todo', 'Ton propre mot de passe', pw ? 'Choisi. Celui de Vercel reste valable en secours.' : 'Tu utilises encore DASHBOARD_PASSWORD, défini dans Vercel : choisis le tien.', pw ? 'Fait' : 'À faire', pw ? '' : btn('go-pw', 'Choisir mon mot de passe')),
          chk(tf ? 'ok' : 'todo', 'Double authentification', tf ? 'Un code de ton téléphone est demandé à chaque connexion.' : 'Un code à 6 chiffres de ton téléphone, en plus du mot de passe.', tf ? 'Activée' : 'À faire', tf ? '' : btn('go-2fa', 'Activer')),
        ].join(''));
      } },

    { title: 'Préparer le switch', sub: 'SSH et adresse IP',
      status: () => (agentOk() ? 'ok' : 'todo'),
      view: () => `<p class="ob-lead">L’agent se connecte au switch en SSH. Vérifie trois choses avant d’installer quoi que ce soit.</p>${autoNote}
        <div class="ob-row"><div><ol class="ob-ol"><li><b>SSH est actif</b> sur le switch.</li>
            <li><b>L’adresse IP de gestion</b> du switch répond depuis le PC qui accueillera l’agent (essaie un <code>ping</code>).</li>
            <li>Tu connais <b>un compte SSH</b> du switch (souvent <code>admin</code>) et son mot de passe.</li></ol></div>
          ${fig('switch-ssh', 'Terminal du switch : show ssh server all-vrfs affiche le bloc SSH du VRF default, et show ip interface vlan1 donne l’adresse 192.168.10.2.', 'Le résultat attendu : un bloc SSH pour ton VRF, et l’adresse IP de gestion.')}</div>
        <div class="ob-sec"><h4>Vérifier</h4>
          <div class="alert amber" style="margin:0 0 10px">${IC.warn}<span>Les commandes ci-dessous se tapent sur le switch (câble console ou session SSH, avec PuTTY par exemple), pas dans le dashboard : sa console ne fonctionne qu’une fois l’agent connecté.</span></div>
          <p>Cherche le bloc « SSH server configuration on VRF default » (ou <code>mgmt</code>), puis l’adresse IP de gestion (ligne « IPv4 address »). Le VRF est le réseau par lequel tu joins le switch : <code>default</code> pour les ports normaux, <code>mgmt</code> pour le port de gestion MGMT.</p>
          ${cmd(['show ssh server all-vrfs', 'show ip interface vlan1'], 'Copier les commandes de vérification')}
          <p class="note" style="margin-top:8px">Switch avec un port de gestion dédié (marqué MGMT, par exemple 6200, 6300) : l’adresse se lit avec <code>show interface mgmt</code>.</p></div>
        <div class="ob-sec"><h4>Activer SSH, si besoin</h4>
          ${cmd(['configure terminal', 'ssh server vrf default', 'end', 'write memory'], 'Copier les commandes d’activation')}
          <p class="note" style="margin-top:8px">Si le PC de l’agent passe par le port de gestion MGMT, remplace <code>vrf default</code> par <code>vrf mgmt</code> (les 4100i, 6000 et 6100 n’ont que le VRF default). SSH ne marche qu’une fois le mot de passe du compte <code>admin</code> du switch défini.</p></div>` },

    { title: 'Préparer le PC', sub: 'Python et agent',
      status: () => (agentOk() ? 'ok' : 'todo'),
      view: () => `<p class="ob-lead">L’agent tourne sur un PC Windows allumé en permanence et branché sur le même réseau que le switch (un mini PC suffit).</p>${autoNote}
        <div class="ob-row"><div><h4 class="ob-n" data-n="1">Installe Python 3</h4>
            <p>Prends l’installateur classique (lien « standalone installer » ou « Windows installer (64-bit) »), lance-le et coche bien <b>« Add python.exe to PATH »</b> avant de cliquer sur <b>Install Now</b>.</p>
            <div class="ob-acts"><a class="btn" href="${PYTHON}" target="_blank" rel="noopener">Télécharger Python${IC.ext}<span class="sr"> (python.org, nouvel onglet)</span></a></div></div>
          ${fig('python-install', 'Installateur Python : la case « Add python.exe to PATH » est cochée, puis bouton « Install Now ».', 'Coche « Add python.exe to PATH », puis Install Now.')}</div>
        <div class="ob-row"><div><h4 class="ob-n" data-n="2">Télécharge l’agent</h4>
            <p>Sur la page de la dernière version, télécharge <code>aruba-agent-x.y.z.zip</code>. Clic droit, <b>Extraire tout…</b> vers <code>C:\\</code>, puis renomme le dossier obtenu en <code>aruba-agent</code> : les fichiers doivent être directement dans <code>C:\\aruba-agent</code>.</p>
            <div class="ob-acts"><a class="btn" href="${esc(download())}" target="_blank" rel="noopener">Télécharger l’agent${IC.ext}<span class="sr"> (GitHub, nouvel onglet)</span></a></div></div>
          ${fig('agent-folder', 'Dossier C:\\aruba-agent avec agent.py, requirements.txt, installer-service.bat et agent_config.json.', 'Le dossier C:\\aruba-agent une fois décompressé.')}</div>
        <div class="ob-row"><div><h4 class="ob-n" data-n="3">Installe les dépendances</h4>
            <p>Ouvre <code>C:\\aruba-agent</code> dans l’explorateur, tape <code>cmd</code> dans la barre d’adresse, puis Entrée. Dans la fenêtre noire, colle :</p>
            ${cmd(['python -m pip install -r requirements.txt'], 'Copier la commande pip')}
            <p class="note" style="margin-top:8px">Message « python n’est pas reconnu » ou « Python est introuvable », ou le Microsoft Store qui s’ouvre : réinstalle Python en cochant « Add python.exe to PATH », puis ouvre une nouvelle invite de commandes.</p></div></div>` },

    { title: 'Configurer l’agent', sub: 'agent_config.json',
      status: () => (agentOk() || cfgSaved() ? 'ok' : 'todo'),
      view: () => `<p class="ob-lead">Le dashboard prépare le fichier de configuration de l’agent, déjà rempli avec son adresse et le jeton de l’agent. Il ne te reste qu’à indiquer le switch.</p>
        <div class="ob-row"><form class="ob-form" id="obCfgForm" novalidate>
            <div class="field"><label for="obHost">Adresse IP du switch <span class="req" aria-hidden="true">*</span></label>
              <input id="obHost" type="text" required aria-required="true" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="253" placeholder="ex. 192.168.10.2" aria-describedby="obHostHint obHostErr">
              <span class="note" id="obHostHint">Son adresse de gestion, vue à l’étape 3 (ligne « IPv4 address »).</span>
              <span class="field-err" id="obHostErr" hidden></span></div>
            <div class="field"><label for="obUser">Compte SSH du switch</label>
              <input id="obUser" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="32" aria-describedby="obUserHint obUserErr">
              <span class="note" id="obUserHint">Souvent <code>admin</code>. Son mot de passe sera demandé à l’installation, sur le PC : il ne passe jamais par le dashboard.</span>
              <span class="field-err" id="obUserErr" hidden></span></div>
            <div class="field"><label for="obNet">Réseau à scanner (facultatif)</label>
              <input id="obNet" type="text" autocomplete="off" spellcheck="false" maxlength="18" placeholder="ex. 192.168.1.0/24" aria-describedby="obNetHint obNetErr">
              <span class="note" id="obNetHint">Pour retrouver l’adresse IP des appareils branchés. Laisse vide si tu ne sais pas.</span>
              <span class="field-err" id="obNetErr" hidden></span></div>
            <div class="alert amber" style="margin:0 0 12px">${IC.warn}<span><b>Ce fichier contient le jeton de l’agent :</b> ne le partage pas, ne le publie pas (ni sur GitHub, ni par e-mail).</span></div>
            <div><button class="btn" id="obCfgBtn" data-main>${IC.down}Télécharger agent_config.json</button></div>
            <div class="alert red" id="obCfgErr" role="alert" hidden></div>
            <div class="ob-done" id="obCfgOk" role="status" hidden></div>
            <p class="note" style="margin:12px 0 0">Place le fichier dans <code>C:\\aruba-agent</code>, à côté de <code>agent.py</code>, sous ce nom exact : c’est lui que l’agent lit (le fichier d’exemple <code>agent_config.example.json</code> peut rester).</p>
            <p class="note" id="obCfgUrlP" style="margin:8px 0 0" hidden>L’agent enverra l’état du switch à <code id="obCfgUrl"></code>, l’adresse de ce dashboard écrite dans le fichier.</p>
          </form>
          ${fig('agent-folder', 'Dossier C:\\aruba-agent : agent_config.json, le fichier téléchargé depuis le dashboard, est mis en avant à côté de installer-service.bat.', 'agent_config.json va dans C:\\aruba-agent.')}</div>`,
      mount: mountConfig,
      live: () => {
        $('#obCfgUrlP').hidden = !SD?.dashboardUrl;
        $('#obCfgUrl').textContent = SD?.dashboardUrl || '';
        const ok = $('#obCfgOk');
        if (ok && ok.hidden && (cfgSaved() || agentOk())) {
          ok.hidden = false;
          setHTML(ok, `${IC.ok}<span>${agentOk() ? 'L’agent est connecté avec sa configuration.' : 'Fichier déjà téléchargé depuis ce navigateur. Tu peux le retélécharger si besoin.'}</span>`);
        }
      } },

    { title: 'Installer et connecter', sub: 'Service Windows',
      status: () => (agentOk() ? 'ok' : 'wait'),
      view: () => `<p class="ob-lead">Dernière étape sur le PC : installer l’agent comme service Windows, pour qu’il démarre tout seul, même sans session ouverte.</p>
        <div class="ob-row"><div><h4 class="ob-n" data-n="1">Lance l’installation</h4>
            <p>Dans <code>C:\\aruba-agent</code>, fais un clic droit sur <code>installer-service.bat</code>, puis <b>Exécuter en tant qu’administrateur</b>.</p></div>
          ${fig('run-as-admin', 'Clic droit sur installer-service.bat, puis « Exécuter en tant qu’administrateur » dans le menu.', 'Clic droit, Exécuter en tant qu’administrateur.')}</div>
        <div class="ob-row"><div><h4 class="ob-n" data-n="2">Saisis le mot de passe SSH du switch</h4>
            <p>Rien ne s’affiche pendant la frappe : c’est normal. Windows l’enregistre chiffré sur ce PC ; il n’est jamais envoyé au dashboard.</p></div>
          ${fig('agent-password', 'Console : saisie masquée du mot de passe SSH de admin@192.168.10.2, puis « Service installé et démarré ».', 'Le service s’installe et démarre tout seul.')}</div>
        <div class="ob-row"><div><h4 class="ob-n" data-n="3">Attends la connexion</h4>
          <div class="ob-wait" id="obWait"><span class="ob-ci" id="obWaitIc"></span><div><b id="obWaitTitle" aria-live="polite"></b><p id="obWaitSub"></p></div>
            <button type="button" class="btn small" data-ob="check" id="obCheckNow">Vérifier maintenant</button></div></div></div>
        <details class="ob-details ob-sec"><summary>${icon('expand_more', { cls: 'chev' })}Ça ne se connecte pas ?</summary><ul class="ob-list">
          <li><b>Le PC s’est mis en veille</b> : règle la mise en veille sur « Jamais » (Paramètres, Système, Alimentation).</li>
          <li><b>Le pare-feu ou l’antivirus bloque Python</b> : autorise <code>python.exe</code> à sortir vers Internet (HTTPS).</li>
          <li><b>Mauvaise adresse du switch</b> : vérifie <code>switch_host</code> dans agent_config.json, et que le PC arrive à faire un <code>ping</code> vers le switch.</li>
          <li><b>SSH refusé</b> : compte ou mot de passe faux, ou SSH inactif (étape 3). Le détail est dans <code>agent.log</code>, dans C:\\aruba-agent ; relance installer-service.bat pour ressaisir le mot de passe.</li>
          <li><b>Mauvaise adresse du dashboard</b> : <code>dashboard_url</code> doit valoir <code id="obDashUrl"></code>.</li>
          <li><b>Jeton modifié sur Vercel</b> : si AGENT_TOKEN a changé, retélécharge agent_config.json (étape 5, « Configurer l’agent ») et remplace l’ancien. Redémarre ensuite l’agent : clic droit sur installer-service.bat, Exécuter en tant qu’administrateur, puis Entrée sans rien taper quand le mot de passe est demandé (celui enregistré est gardé).</li>
        </ul></details>`,
      live: () => {
        const a = K().agent || {}, ok = Boolean(a.ok);
        $('#obWait').className = `ob-wait${ok ? ' ok' : ''}`;
        setHTML($('#obWaitIc'), ok ? IC.ok : '<span class="spinner"></span>');
        const title = !SD ? 'Vérification…' : ok ? `Agent connecté : ${a.host || 'switch'}${a.ports ? ` (${a.ports} ports)` : ''}${a.version ? `, version ${a.version}` : ''}` : 'En attente de l’agent…';
        if ($('#obWaitTitle').textContent !== title) $('#obWaitTitle').textContent = title;
        $('#obWaitSub').textContent = !SD ? '' : ok ? `Dernier envoi ${ago(a.ago || 0)}. Tout est prêt : le tableau de bord affiche ton switch.`
          : `${a.seen ? `Dernier contact ${ago(a.ago || 0)} : l’agent ne répond plus.` : 'Aucun contact pour l’instant.'} La page vérifie toute seule toutes les 10 secondes.`;
        $('#obCheckNow').hidden = ok;
        $('#obDashUrl').textContent = SD?.dashboardUrl || location.origin;
      } },

    { title: 'Inviter l’équipe', sub: 'Comptes et alertes',
      status: () => (K().users?.ok && K().alerts?.ok ? 'ok' : 'opt'),
      view: () => `<p class="ob-lead">Facultatif : invite tes collègues et choisis où recevoir les alertes. Tu pourras aussi le faire plus tard.</p>
        <ul class="ob-checks" id="obTeam" aria-label="Équipe et alertes"></ul>
        <p class="note" style="margin-top:12px">Un compte par personne : chacun a son mot de passe et ses actions sont signées dans le journal d’activité.</p>`,
      live: () => {
        const k = K(), u = k.users || {}, al = k.alerts || {};
        const CH = { email: 'e-mail', webhook: 'webhook', accounts: 'e-mail des comptes' };
        setFocused($('#obTeam'), !SD ? checking() : [
          chk(u.ok ? 'ok' : 'opt', 'Comptes de l’équipe', u.ok ? `${u.count} comptes actifs.` : 'Toi seul pour l’instant. Technicien pour agir sur les ports, lecture seule pour un écran mural.',
            u.ok ? 'Fait' : 'Facultatif', '<button type="button" class="btn small" data-ob="users">Créer des comptes</button>'),
          chk(al.ok ? 'ok' : 'opt', 'Alertes', al.ok ? `Envoyées par ${arr(al.channels).map((x) => CH[x] || x).join(', ')}.` : 'Aucun canal : les alertes ne partent nulle part. Ajoute un e-mail ou un webhook (Teams, Discord, ntfy…).',
            al.ok ? 'Fait' : 'Facultatif', '<button type="button" class="btn small" data-ob="alerts">Régler les alertes</button>'),
        ].join(''));
      } },
  ];
  STEPS[0].status = () => 'info';

  function status(i) { return STEPS[i].status ? STEPS[i].status() : 'info'; }
  const doneCount = () => (SD ? STEPS.slice(1).filter((_, i) => status(i + 1) === 'ok').length : 0);

  // Remplace le contenu d'une liste en gardant le focus sur le même bouton (rafraîchissement toutes les 10 s).
  function setFocused(el, html) {
    if (!el) return;
    const a = document.activeElement, key = el.contains(a) ? (a.dataset.ob || a.dataset.step) : null;
    setHTML(el, html);
    if (key && !el.contains(document.activeElement)) el.querySelector(`[data-ob="${key}"], [data-step="${key}"]`)?.focus();
  }

  // ---------------------------------------------------------------- affichage
  function renderHead() {
    const n = doneCount(), ob = SD?.onboarding || {};
    $('#obBar').style.width = `${Math.round((n / 7) * 100)}%`;
    $('#obProgText').textContent = !SD ? (sdErr ? 'État de l’installation indisponible.' : 'Vérification de l’installation…')
      : ob.done ? `Démarrage terminé${ob.doneAt ? ` le ${fmtDate(ob.doneAt)}` : ''} · ${n} ${plural(n, 'étape vérifiée', 'étapes vérifiées')} sur 7`
        : `${n} ${plural(n, 'étape faite', 'étapes faites')} sur 7`;
    $('#obLater').hidden = Boolean(ob.done);
    $('#obErr').hidden = !sdErr;
    $('#obErrText').textContent = sdErr ? `Impossible de vérifier l’installation : ${sdErr}` : '';
  }
  function renderSteps() {
    setFocused($('#obSteps'), STEPS.map((s, i) => {
      const st = status(i), label = i ? (SD ? ST[st][0] : '…') : s.sub;
      const mark = i && SD && ['wait', 'ko', 'opt'].includes(st) ? `<span class="ob-mark">${IC[st]}</span>` : '';
      return `<li><button type="button" class="ob-sbtn ${i ? st : ''}" data-step="${i}"${i === step ? ' aria-current="step"' : ''}>
        <span class="ob-num" aria-hidden="true">${i === 0 ? IC.play : st === 'ok' ? IC.ok : i}${mark}</span>
        <span class="ob-sl"><b>${i ? `<span class="sr">Étape ${i} : </span>` : ''}${esc(s.title)}</b><small>${i && SD ? IC[st] : ''}${esc(label)}</small></span></button></li>`;
    }).join(''));
  }
  function renderStep(focus) {
    const s = STEPS[step];
    local.set(STEP_KEY, String(step));
    $('#obStep').innerHTML = `<div class="ob-eyebrow"><span>${step ? `Étape ${step} sur 7` : 'Avant de commencer'}</span><span id="obStPill"></span></div>
      <h3 id="obStepTitle" tabindex="-1">${esc(s.title)}</h3>
      ${s.view()}
      <div class="ob-foot">${step ? '<button type="button" class="btn" data-ob="prev">Précédent</button>' : ''}<span class="grow"></span>
        <button type="button" class="btn" data-ob="next" id="obNext">${step === 0 ? 'Commencer' : step === 7 ? 'Terminer' : 'Suivant'}</button></div>
      ${s.after ? s.after() : ''}`;
    rendered = step;
    s.mount?.();
    updateLive();
    if (!focus) return;
    // Nouvelle étape : on remonte en haut de la carte et le focus va sur son titre (lecteurs d'écran, clavier).
    if ($('#obStep').getBoundingClientRect().top < 0) $('#obStep').scrollIntoView({ block: 'start' });
    $('#obStepTitle').focus({ preventScroll: true });
  }
  // Parties qui suivent l'état en direct, sans toucher aux champs ni au reste de l'étape.
  function updateLive() {
    renderHead(); renderSteps(); updateNav();
    if (rendered !== step || !$('#obNext')) return;
    const st = status(step);
    setHTML($('#obStPill'), step && SD ? pill(st) : '');
    STEPS[step].live?.();
    // Une seule action principale : celle de l'étape tant qu'elle reste à faire, sinon « Suivant ».
    const main = qsa('#obStep [data-main]').find((b) => !b.hidden && !b.closest('[hidden]'));
    const mainFirst = Boolean(main) && st !== 'ok';
    qsa('#obStep [data-main]').forEach((b) => b.classList.toggle('primary', mainFirst && b === main));
    $('#obNext').classList.toggle('primary', !mainFirst);
  }
  // Pastille du menu : progression « 3/7 », ou une coche une fois l'assistant terminé.
  function updateNav() {
    const el = $('#navSetupN');
    el.hidden = !SD;
    if (!SD) return;
    const done = Boolean(SD.onboarding?.done), n = doneCount();
    el.className = `n ${done ? 'ok' : 'prog'}`;
    setHTML(el, done ? `${icon('check', { size: 13 })}<span class="sr">, terminé</span>` : `${n}/7<span class="sr"> étapes faites</span>`);
  }

  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    renderStep(true);
  }

  // ---------------------------------------------------------------- état de l'installation (GET ?part=setup)
  function refreshSetup() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const d = await api('/api/settings?part=setup');
        if (!d?.checks || !d.onboarding) throw new Error('réponse inattendue du serveur');
        const wasOk = agentOk();
        SD = d; sdErr = ''; sdAt = Date.now();
        if (NAV.current === 'setup') {
          updateLive();
          if (!wasOk && agentOk() && step === 6) toast('Agent connecté', { type: 'success', sub: `${d.checks.agent.host || 'Le switch'} envoie son état au dashboard.` });
        } else updateNav();
        return d;
      } catch (err) {
        if (err.message !== '401') { sdErr = err.message; if (NAV.current === 'setup') updateLive(); }
        throw err;
      } finally { loading = null; }
    })();
    return loading;
  }
  ADMIN.setupOpen = () => {
    if (step === null) { const saved = Number(local.get(STEP_KEY) ?? 0); step = Number.isInteger(saved) && saved >= 0 && saved < STEPS.length ? saved : 0; }
    renderStep(false);
    if (Date.now() - sdAt > 2000) refreshSetup().catch(() => {}); // sinon : lu à l'instant (connexion)
  };
  // Vue ouverte : relecture toutes les 10 s (agent, double authentification, comptes…).
  setInterval(() => { if (!document.hidden && !$('#app').hidden && NAV.current === 'setup') refreshSetup().catch(() => {}); }, 10000);
  // La vidéo s'arrête quand on quitte la vue.
  new MutationObserver(() => { if ($('#view-setup').hidden) qsa('#view-setup video').forEach((v) => v.pause()); })
    .observe($('#view-setup'), { attributes: true, attributeFilter: ['hidden'] });

  // ---------------------------------------------------------------- actions
  $('#obSteps').addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) go(Number(b.dataset.step)); });
  $('#obStep').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ob]'); if (!b) return;
    const act = b.dataset.ob;
    if (act === 'prev') return go(step - 1);
    if (act === 'next') return step === STEPS.length - 1 ? finish(b) : go(step + 1);
    if (act === 'recheck' || act === 'check') return busy(b, () => refreshSetup().catch(() => {})).then(keepFocus);
    if (act === 'go-pw' || act === 'go-2fa') {
      history.replaceState(null, '', '#profil'); NAV.show('profile');
      setTimeout(() => { const el = act === 'go-pw' ? $('#pwCur') : ($('#tfStart').hidden ? $('#tfCode') : $('#tfStart')); el?.scrollIntoView({ block: 'center' }); el?.focus(); }, 400);
      return;
    }
    if (act === 'users') { history.replaceState(null, '', '#utilisateurs'); return NAV.show('users', { focus: true }); }
    if (act === 'alerts') return openAlertSettings();
  });
  $('#obRetry').addEventListener('click', (e) => busy(e.currentTarget, () => refreshSetup().catch(() => {})).then(keepFocus));
  // Après une action, le bouton qui avait le focus a pu disparaître : le focus va au titre de l'étape, pas sur la page.
  function keepFocus() {
    if (document.activeElement && document.activeElement !== document.body) return;
    if (NAV.current === 'setup') ($('#obStepTitle') || $('#setupTitle')).focus({ preventScroll: true });
  }

  async function saveOnboarding(btn, patch, done) {
    await busy(btn, async () => {
      try {
        const d = await api('/api/settings', { action: 'onboarding-save', ...patch });
        if (SD) SD.onboarding = d.onboarding || { ...SD.onboarding, ...patch };
        updateNav(); markWelcomed(); // l'assistant commence par la présentation : pas de fenêtre de bienvenue ensuite
        history.replaceState(null, '', '#tableau-de-bord'); NAV.show('dashboard');
        $('#hostname').focus({ preventScroll: true });
        done();
      } catch (err) { if (err.message !== '401') toast('Impossible d’enregistrer', { type: 'error', sub: err.message }); }
    });
  }
  const finish = (btn) => saveOnboarding(btn, { done: true }, () => toast('Démarrage terminé', { type: 'success', sub: 'Tu retrouveras ces étapes dans le menu, rubrique Démarrage.' }));
  $('#obLater').addEventListener('click', (e) => saveOnboarding(e.currentTarget, { dismissed: true },
    () => toast('Assistant mis de côté', { sub: 'Reprends quand tu veux : menu, rubrique Démarrage.' })));

  // ---------------------------------------------------------------- étape 5 : agent_config.json
  const IP4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  function hostError(v) {
    if (!v) return 'Indique l’adresse IP du switch, par exemple 192.168.10.2.';
    if (/^[\d.]+$/.test(v)) {
      if (!IP4.test(v)) return 'Adresse IP invalide : 4 nombres de 0 à 255 séparés par des points, sans zéro au début (ex. 192.168.10.2).';
      const first = Number(v.split('.')[0]);
      return first === 0 || first >= 224 ? 'Cette adresse ne peut pas être celle du switch : indique son adresse IP de gestion.' : '';
    }
    return v.length <= 253 && v.split('.').every((l) => LABEL.test(l)) ? ''
      : 'Adresse invalide : une adresse IP (ex. 192.168.10.2) ou un nom d’hôte, sans espace, sans « http » ni numéro de port.';
  }
  const RULES = {
    obHost: hostError,
    obUser: (v) => (v && !/^[A-Za-z0-9._-]{1,32}$/.test(v) ? 'Compte invalide : lettres, chiffres, point, tiret ou tiret bas, 32 caractères au plus.' : ''),
    obNet: (v) => {
      if (!v) return '';
      const m = /^([\d.]+)\/(\d{1,2})$/.exec(v);
      if (!m || !IP4.test(m[1])) return 'Réseau invalide : une adresse suivie de son préfixe, par exemple 192.168.1.0/24.';
      // L'agent ne cherche pas au-delà de 1024 adresses (/22) : un réseau plus grand désactiverait la recherche.
      return Number(m[2]) < 22 || Number(m[2]) > 30 ? 'Préfixe invalide : entre /22 et /30 (l’agent cherche sur 1024 adresses au plus ; /24 couvre 254 adresses, le cas le plus courant).' : '';
    },
  };
  function validate(id) {
    const el = $(`#${id}`), msg = RULES[id](el.value.trim()), err = $(`#${id}Err`);
    if (msg) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
    err.textContent = msg; err.hidden = !msg;
    return !msg;
  }
  function mountConfig() {
    const map = { obHost: 'host', obUser: 'user', obNet: 'net' };
    for (const [id, key] of Object.entries(map)) {
      const el = $(`#${id}`);
      el.value = CFG[key];
      el.addEventListener('input', () => { CFG[key] = el.value; if (el.hasAttribute('aria-invalid')) validate(id); });
      el.addEventListener('blur', () => { if (el.value.trim() || el.hasAttribute('aria-invalid')) validate(id); });
    }
    $('#obCfgForm').addEventListener('submit', (e) => { e.preventDefault(); downloadConfig(); });
  }
  async function downloadConfig() {
    const ids = ['obHost', 'obUser', 'obNet'], ok = ids.map(validate);
    if (ok.includes(false)) return $(`#${ids[ok.indexOf(false)]}`).focus();
    const err = $('#obCfgErr'); err.hidden = true;
    const host = $('#obHost').value.trim();
    await busy($('#obCfgBtn'), async () => {
      try {
        const d = await api('/api/settings', { action: 'agent-config', switch_host: host, switch_user: $('#obUser').value.trim() || 'admin', scan_subnet: $('#obNet').value.trim() });
        if (!d?.config || typeof d.config !== 'object') throw new Error('Réponse inattendue du serveur.');
        const name = /^[\w.-]{1,64}\.json$/.test(d.filename || '') ? d.filename : 'agent_config.json';
        const url = URL.createObjectURL(new Blob([`${JSON.stringify(d.config, null, 2)}\n`], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        local.set(CFG_KEY, String(Date.now()));
        const box = $('#obCfgOk');
        if (box) {
          setHTML(box, `${IC.ok}<span><b>${esc(name)} téléchargé</b> pour le switch ${esc(d.config.switch_host || host)}.</span>`);
          box.hidden = false;
        }
        toast(`${name} téléchargé`, { type: 'success', sub: 'Place-le dans C:\\aruba-agent.' });
        updateLive();
      } catch (e) {
        if (e.message === '401') return;
        const msg = e.data?.need2fa ? 'Active d’abord la double authentification de ton compte (étape 2, « Sécuriser ton compte ») : un administrateur l’exige pour cette action.' : e.message;
        setHTML(err, `${IC.ko}<span>${esc(msg)}</span>`);
        err.hidden = false;
      }
    });
  }

  // ================================================================ connexion : assistant ou bienvenue
  const ROLE_INFO = {
    admin: ['Tu as accès à tout, y compris aux comptes.', ['Gérer les utilisateurs et leurs droits', 'Agir sur les ports, les VLAN, les profils et les actions planifiées', 'Utiliser la console, les réglages, les alertes et les sauvegardes']],
    tech: ['Tu agis sur les ports d’accès, pas sur la configuration du switch.', ['Activer, couper ou redémarrer un port', 'Changer la description et le VLAN d’un port', 'Tester les câbles, allumer des PC à distance, nommer les appareils']],
    viewer: ['Tu regardes, sans rien modifier : idéal pour un écran mural.', ['Voir le tableau de bord, la façade et les alertes', 'Suivre le débit et l’historique', 'Aucune action possible sur le switch']],
  };
  const ROLE_PILL = { admin: 'accent', tech: 'info', viewer: '' };
  let session = null, welcomeAsked = false, welcomedSent = false;

  HOOK.poll.push((d) => {
    const me = d.me || ME;
    $('#firstBox').hidden = true; forceLogin = false; // installation déjà utilisée : plus de « Première connexion »
    if (!me) return;
    if (session !== me.id) { session = me.id; welcomeAsked = welcomedSent = false; start(d, me); return; }
    // Agent qui vient d'arriver ou de partir : on relit tout de suite au lieu d'attendre les 10 s.
    if (NAV.current === 'setup' && SD && Date.now() - sdAt > 5000) {
      const fresh = Boolean(S?.received) && NOW - S.received < 170;
      if (fresh !== agentOk()) refreshSetup().catch(() => {});
    }
  });
  $('#logout').addEventListener('click', () => { session = null; SD = null; step = null; rendered = -1; $('#navSetupN').hidden = true; });

  async function start(d, me) {
    if (ROLE !== 'admin') return maybeWelcome(me);
    // Une seconde tentative si le serveur hoquette (fonction froide, réseau) : sinon l'assistant ne s'ouvrirait pas.
    try { await refreshSetup(); } catch (err) {
      if (err.message === '401' || err.status < 500) return;
      await new Promise((r) => setTimeout(r, 2000));
      if (session !== me.id) return;
      try { await refreshSetup(); } catch { return; }
    }
    if (session !== me.id) return; // déconnecté entre-temps
    const ob = SD.onboarding;
    if (!ob.done && !ob.dismissed) {
      // Ouverture automatique, sauf si la double authentification exigée doit d'abord être activée (Mon profil).
      if (canAdmin() && !d.need2fa) { history.replaceState(null, '', '#demarrage'); NAV.show('setup', { focus: true }); }
      return;
    }
    maybeWelcome(me);
  }

  function maybeWelcome(me) {
    if (welcomeAsked || me?.prefs?.welcomed !== false || NAV.current === 'setup' || $('#app').hidden) return;
    welcomeAsked = true;
    const name = String(me.name || '').trim();
    $('#wcTitle').textContent = `Bienvenue, ${(me.role === 'viewer' ? name : name.split(/\s+/)[0]) || me.login}`;
    const [text, list] = ROLE_INFO[me.role] || ROLE_INFO.viewer;
    $('#wcRole').className = `pill ${ROLE_PILL[me.role] || ''}`;
    $('#wcRole').textContent = ROLE_FR[me.role] || me.role;
    $('#wcRoleText').textContent = text;
    setHTML($('#wcRoleList'), list.map((x) => `<li>${esc(x)}</li>`).join(''));
    $('#wcSecure').hidden = $('#wcSecureBtn').hidden = Boolean(me.has2fa);
    $('#welcomeDialog').showModal();
    $('#wcTitle').focus();
    autoplay($('#wcPlayer'));
  }
  async function markWelcomed() {
    if (welcomedSent) return;
    welcomedSent = true;
    try { const d = await api('/api/settings', { action: 'profile-welcomed' }); if (d?.me) ME = d.me; } catch { welcomedSent = false; }
  }
  $('#wcGo').addEventListener('click', () => $('#welcomeDialog').close());
  $('#wcSecureBtn').addEventListener('click', () => {
    $('#welcomeDialog').close();
    history.replaceState(null, '', '#profil'); NAV.show('profile', { focus: true });
  });
  // Fermée d'une façon ou d'une autre (bouton, Échap) : la fenêtre ne revient plus, et le focus va au titre de la page.
  $('#welcomeDialog').addEventListener('close', () => {
    $('#wcPlayer').pause(); markWelcomed();
    const a = document.activeElement; // encore sur « C'est parti » (fenêtre fermée) : à déplacer
    if (a && a !== document.body && !$('#welcomeDialog').contains(a)) return; // « Sécuriser mon compte » : Mon profil
    const h = NAV.current === 'dashboard' ? $('#hostname') : $(`#view-${NAV.current} h2[tabindex]`);
    h?.focus({ preventScroll: true });
  });
})();
