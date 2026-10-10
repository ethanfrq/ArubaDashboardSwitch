// Thème choisi (clair ou sombre), appliqué avant l'affichage pour éviter un flash.
try { const t = localStorage.getItem('theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) {}
