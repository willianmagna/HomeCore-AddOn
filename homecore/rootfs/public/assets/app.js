// HomeCore shared UI bootstrapping.
// Requires: <link rel="stylesheet" href="assets/app.css">  +  <script src="assets/lucide.min.js">  loaded before this file.
//
// Layout: sidebar fixa à esquerda (sempre presente) + header in-page com title + actions.

(function () {
  const THEME_KEY = 'homecore-theme';

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch {}
  }

  function currentTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {}
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  applyTheme(currentTheme());

  function toggleTheme() {
    applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    refreshIcons();
  }

  function refreshIcons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      window.lucide.createIcons();
    }
  }

  const SIDEBAR_KEY_MAP = {
    devices: 'ir',
    zigbee:  'zigbee', 'zigbee-devices': 'zigbee', 'zigbee-pair': 'zigbee',
    wifi:    'wifi', 'wifi-scan': 'wifi', tuya: 'wifi', 'wifi-devices': 'wifi',
    areas:   'areas',
    library: 'library', learn: 'library', maintenance: 'library',
    emitters: 'emitters',
    control:  'control',
  };

  const SIDEBAR_ITEMS = [
    { key: 'wifi',   href: 'dispositivos.html', icon: 'wifi',     label: 'Módulos Wi-Fi' },
    { key: 'zigbee', href: 'zigbee.html', icon: 'hexagon',        label: 'Módulos Zigbee' },
    { key: 'ir',     href: 'index.html',  icon: 'radio-tower',    label: 'Dispositivos IR' },
    { section: 'Configurações', items: [
      { key: 'areas',    href: 'areas.html',           icon: 'layout-dashboard', label: 'Cômodos' },
      { key: 'library',  href: 'library.html',         icon: 'library',          label: 'Biblioteca IR' },
      { key: 'emitters', href: 'learn.html#dispositivos', icon: 'cast',          label: 'Emissores IR' },
      { key: 'control',  href: 'learn.html#controle',  icon: 'gamepad-2',        label: 'Controle Remoto' },
    ]},
  ];

  function buildSidebar(activeMapped) {
    const renderLink = (it, isSub = false) => {
      const classes = [];
      if (isSub) classes.push('sub-link');
      if (it.key === activeMapped) classes.push('active');
      return `<a href="${it.href}" class="${classes.join(' ')}">
        <i data-lucide="${it.icon}" class="icon"></i>
        <span class="label">${it.label}</span>
      </a>`;
    };
    const links = SIDEBAR_ITEMS.flatMap((it) => {
      if (it.section) {
        return [
          `<div class="section-label">${it.section}</div>`,
          ...(it.items || []).map((c) => renderLink(c)),
        ];
      }
      const out = [renderLink(it)];
      if (Array.isArray(it.children)) {
        for (const child of it.children) out.push(renderLink(child, true));
      }
      return out;
    }).join('');
    return `
      <div class="brand">
        <div class="brand-text">HOMECORE</div>
      </div>
      <nav class="nav">
        ${links}
      </nav>
      <div class="footer">
        <button class="theme-toggle" title="Alternar tema">
          <i data-lucide="sun" class="icon icon-sun"></i>
          <i data-lucide="moon" class="icon icon-moon"></i>
          <span class="btn-label">Alternar tema</span>
        </button>
      </div>
    `;
  }

  function mountSidebar(activeKey) {
    const mapped = SIDEBAR_KEY_MAP[activeKey] || activeKey;
    let aside = document.querySelector('aside.app-sidebar');
    if (!aside) {
      aside = document.createElement('aside');
      aside.className = 'app-sidebar';
      document.body.insertBefore(aside, document.body.firstChild);
    }
    aside.innerHTML = buildSidebar(mapped);
    aside.querySelectorAll('.theme-toggle').forEach((b) =>
      b.addEventListener('click', toggleTheme)
    );
    refreshIcons();
  }

  // Sub-navegação contextual do header (por seção). active = chave da página.
  const SUBNAV_BY_SECTION = {
    wifi: [
      { key: 'wifi-devices', href: 'dispositivos.html', icon: 'plug',  label: 'Dispositivos' },
      { key: 'wifi-scan', href: 'wifi-scan.html',    icon: 'radar', label: 'Buscar' },
    ],
    zigbee: [
      { key: 'zigbee-devices', href: 'zigbee.html',      icon: 'hexagon', label: 'Dispositivos' },
      { key: 'zigbee-pair',    href: 'zigbee-pair.html', icon: 'link',    label: 'Parear' },
    ],
    library: [
      { key: 'library',     href: 'library.html',        icon: 'library',        label: 'Biblioteca' },
      { key: 'learn',       href: 'learn.html#capturar', icon: 'graduation-cap', label: 'Capturar' },
      { key: 'maintenance', href: 'learn.html#config',   icon: 'wrench',         label: 'Manutenção' },
    ],
  };

  function buildSubnavHtml(activeKey) {
    const section = SIDEBAR_KEY_MAP[activeKey];
    const items = SUBNAV_BY_SECTION[section];
    if (!items || items.length < 2) return '';
    const links = items.map((l) =>
      `<a href="${l.href}" class="${l.key === activeKey ? 'active' : ''}">
        <i data-lucide="${l.icon}" class="icon"></i>${l.label}
      </a>`
    ).join('');
    return `<nav class="page-subnav">${links}</nav>`;
  }

  function mountSubnav(activeKey, customHtml) {
    const header = document.querySelector('header.app-header');
    if (!header) return;
    document.querySelectorAll('nav.page-subnav').forEach((n) => n.remove());
    const html = customHtml || buildSubnavHtml(activeKey);
    if (!html) return;
    let bar;
    if (customHtml) {
      bar = document.createElement('nav');
      bar.className = 'page-subnav';
      bar.innerHTML = html;
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      bar = tmp.firstElementChild;
    }
    const actions = header.querySelector('.app-actions');
    if (actions) header.insertBefore(bar, actions);
    else header.appendChild(bar);
  }

  function buildHeader(opts) {
    // opts: { icon, title (ignorado — sidebar já indica seção), active?, actions? }
    return `
      <div class="app-actions">
        ${opts.actions || ''}
      </div>
    `;
  }

  function mountHeader(opts) {
    if (opts && opts.active) mountSidebar(opts.active);
    const host = document.querySelector('header.app-header');
    if (host) {
      host.innerHTML = buildHeader(opts);
      refreshIcons();
    } else if (!opts || !opts.active) {
      mountSidebar('');
    }
    if (opts && (opts.active || opts.tabs)) {
      mountSubnav(opts.active, opts.tabs);
    }
  }

  window.HomeCore = {
    mountHeader,
    mountSidebar,
    refreshIcons,
    toggleTheme,
    applyTheme,
    currentTheme,
  };

  if (document.readyState !== 'loading') refreshIcons();
  else document.addEventListener('DOMContentLoaded', refreshIcons);

  // Esc fecha qualquer modal-backdrop visível.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelectorAll('.modal-backdrop.show');
    if (!open.length) return;
    open.forEach((m) => m.classList.remove('show'));
  });

  // Auto-render lucide icons quando markup novo for injetado via innerHTML.
  // Reduz custo enfileirando 1 createIcons por frame.
  let _iconRenderQueued = false;
  const _autoRenderObserver = new MutationObserver(() => {
    if (_iconRenderQueued) return;
    if (!document.querySelector('[data-lucide]')) return;
    _iconRenderQueued = true;
    requestAnimationFrame(() => {
      _iconRenderQueued = false;
      refreshIcons();
    });
  });
  function _startObserver() {
    if (document.body) _autoRenderObserver.observe(document.body, { childList: true, subtree: true });
    else document.addEventListener('DOMContentLoaded', _startObserver);
  }
  _startObserver();
})();
