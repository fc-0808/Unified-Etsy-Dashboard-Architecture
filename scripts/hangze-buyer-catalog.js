'use strict';

/**
 * Buyer-facing Hangze custom-case catalog.
 * 33 Apple cases + 6 Samsung cases from the 2026 factory sheet.
 * MagSafe accessories and blank-model acrylics stay off the buyer menu.
 */

function style(id, name, blurb, chips, extra) {
  return Object.assign({
    id,
    name,
    blurb,
    chips,
    img: `samples/${id}.jpg`,
    colors: '',
    feel: '',
    material: '',
    print: '',
  }, extra || {});
}

const APPLE_PAGES = [
  {
    title: 'MagSafe, then wrap',
    meta: 'Collection 01–06',
    kicker: 'iPhone · custom print',
    lede: 'MagSafe is only No. 01 and No. 02. Styles 03–06 wrap your art around the sides and do not include MagSafe. Each card lists color, feel, material, and print.',
    steps: true,
    contents: '01–02 MagSafe  ·  03–06 Wrap  ·  07–14 Glass  ·  15–21 Acrylic  ·  22–33 Soft  ·  Models p.5',
    groups: [
      { label: 'MagSafe', note: 'Built-in magnet · only these two', magsafe: true, from: 0, to: 2 },
      { label: 'Wrap', note: 'Print wraps the sides · no MagSafe', from: 2, to: 6 },
    ],
    styles: [
      style('magsafe-clear', 'MagSafe clear', 'Your phone color stays visible under the print.', [], {
        magsafe: true, colors: 'Clear', feel: 'Soft bumper, rigid back', material: 'Acrylic + TPU', print: 'Back print',
      }),
      style('magsafe-wrap', 'MagSafe wrap', 'Print wraps the sides. MagSafe ring on the back.', ['Wrap'], {
        magsafe: true, photoFit: 'contain', photoBox: { w: 720, h: 1522 },
        colors: 'Your artwork', feel: 'Soft inside, hard outside, slight curve', material: 'TPU + PC', print: 'Full wrap',
      }),
      style('full-wrap', 'Full-wrap film', 'The thinnest wrap. Print continues around the edges.', ['Wrap'], {
        colors: 'Your artwork · gloss or matte · precise or large hole', feel: 'Ultra-thin, hard', material: 'PC film', print: 'Full wrap',
      }),
      style('soft-wrap', 'Soft wrap', 'Softer than thin hard film. Print still wraps the sides.', ['Wrap'], {
        colors: 'Your artwork', feel: 'Semi-rigid soft', material: 'TPU film', print: 'Full wrap',
      }),
      style('dual-wrap', 'Dual-layer wrap', 'Thicker in the hand than thin film.', ['Wrap'], {
        colors: 'Your artwork · gloss or matte', feel: 'Soft inside, hard outside, slight curve', material: 'TPU + PC', print: 'Full wrap',
      }),
      style('wave-wrap', 'Wave wrap', 'Wavy dual-layer wrap. Not made for Mini or iPhone 11 Pro.', ['Wrap', { t: '11–18 · no Mini', warn: true }], {
        colors: 'Your artwork', feel: 'Soft inside, hard outside, slight curve', material: 'TPU + PC', print: 'Full wrap',
      }),
    ],
  },
  {
    title: 'Glass backs',
    meta: 'Collection 07–14',
    kicker: 'iPhone · glass',
    lede: 'Hard glass or glass-like backs with a soft bumper. Color on the card is the shell — your art still prints on top.',
    styles: [
      style('glass-back', 'Glass back', 'The classic poster-on-glass look.', [], {
        colors: 'Black bumper', feel: 'Soft bumper, rigid back', material: 'Glass + PC + TPU', print: 'Back print',
      }),
      style('crystal-glaze', 'Crystal glaze', 'Black bumper, glossy printed back. iPhone 11 through 18 Pro Max.', [{ t: '11–18 Pro Max', warn: true }], {
        blank: true, colors: 'Black bumper', feel: 'Printed back', material: 'PC + TPU + film', print: 'Heat-transfer back',
      }),
      style('liquid-paint-glass', 'Painted glass', 'Colored glass base under your print.', [], {
        colors: 'Black, white, sand pink, lilac', feel: 'Soft bumper, rigid back', material: 'Glass + PC + TPU', print: 'Back print',
      }),
      style('metallic-glass', 'Metallic glass', 'Metal-look glass under your print.', [], {
        colors: 'Silver, pink, green, blue, plum', feel: 'Soft bumper, rigid back', material: 'Glass + PC + TPU', print: 'Back print',
      }),
      style('aurora-glass', 'Aurora glass', 'Frosted holographic sheet. Apple only.', [], {
        colors: 'Frosted holographic', feel: 'Soft bumper, slightly curved back', material: 'Holographic sheet + TPU + PC', print: 'Back print',
      }),
      style('iridescent', 'Iridescent silver', 'Shimmery colored back. iPhone 11 through 18 Pro Max.', [{ t: '11–18 Pro Max', warn: true }], {
        colors: '6 shell colors', feel: 'Soft bumper, rigid back', material: 'PC + TPU', print: 'Back print',
      }),
      style('large-cut-glass', 'Large-cut glass', 'Gloss glass with a wide camera opening.', [], {
        colors: 'Plated or skin-feel black · large hole', feel: 'Soft bumper, rigid back', material: 'Gloss glass + PC + TPU', print: 'Inner print',
      }),
      style('frosted-glass', 'Frosted glass', 'Matte AG glass. Print sits on the inner layer.', [], {
        colors: 'Plated or skin-feel black · large hole', feel: 'Soft bumper, rigid back', material: 'Matte glass + PC + TPU', print: 'Inner print',
      }),
    ],
  },
  {
    title: 'Acrylic and leather',
    meta: 'Collection 15–21',
    kicker: 'iPhone · acrylic',
    lede: 'Hard acrylic backs, or a soft leather wrap. Mirror finishes photograph well and show fingerprints. Add a bumper color if the card lists one.',
    styles: [
      style('clear-acrylic', 'Clear acrylic', 'Soft bumper with a hard clear acrylic back.', [], {
        colors: 'Clear', feel: 'Soft bumper, rigid back', material: 'Acrylic + TPU', print: 'Back print',
      }),
      style('acrylic-mirror', 'Acrylic mirror', 'Photographs well. Shows fingerprints.', [], {
        colors: 'Mirror', feel: 'Soft bumper, rigid back', material: 'Acrylic + TPU', print: 'Back print',
      }),
      style('frosted-acrylic', 'Frosted acrylic', 'Matte acrylic. Print sits on the inner layer.', [], {
        colors: 'Plated or skin-feel black · large hole', feel: 'Soft bumper, rigid back', material: 'Matte acrylic + PC + TPU', print: 'Inner print',
      }),
      style('large-frame-mirror', 'Frame mirror', 'Mirror patch with a large camera frame.', [], {
        colors: 'Plated or skin-feel black · large hole', feel: 'Soft bumper, rigid back', material: 'Mirror sheet + PC + TPU', print: 'Back print',
      }),
      style('black-frame-acrylic', 'Black-frame acrylic', 'Black bumper acrylic. Not made for Mini or iPhone 11 Pro.', [{ t: '11–15 · limited', warn: true }], {
        colors: 'Black bumper', feel: 'Soft bumper, rigid back', material: 'Acrylic + TPU', print: 'Back print',
      }),
      style('grooved-acrylic', 'Grooved acrylic', 'Frosted grooved acrylic. iPhone 11 through 18 Pro Max.', [{ t: '11–18 Pro Max', warn: true }], {
        feel: 'Frosted grooved', material: 'Acrylic + PC + TPU', print: 'Inner print',
      }),
      style('lambskin', 'Lambskin wrap', 'Soft leather wrap with your print around the sides.', ['Wrap'], {
        colors: 'Black or white', feel: 'Fully soft leather wrap', material: 'Lambskin on TPU', print: 'Print + wrap',
      }),
    ],
  },
  {
    title: 'Soft cases',
    meta: 'Collection 22–33',
    kicker: 'iPhone · soft',
    lede: 'Flexible TPU and silicone. Bright back print. Each card lists color, feel, material, and print. Add the color if you see one.',
    dense: true,
    styles: [
      style('clear-soft', 'Clear soft', 'Flexible clear TPU. Bright print on the back.', [], {
        colors: 'Clear · precise or large hole', feel: 'Fully soft clear', material: 'TPU', print: 'Back print',
      }),
      style('space-clear', 'Space clear', 'Soft clear with a large or precise camera hole.', [], {
        colors: 'Clear · precise or large hole', feel: 'Fully soft clear', material: 'TPU', print: 'Back print',
      }),
      style('cream', 'Cream texture', 'Soft puffy clear texture. Light in the hand.', [], {
        colors: '3 colors', feel: 'Fully soft, puffy texture', material: 'TPU', print: 'Back print',
      }),
      style('jelly', 'Jelly', 'Squishy jelly shell.', [], {
        colors: '6 colors', feel: 'Fully soft jelly', material: 'TPU', print: 'Back print',
      }),
      style('dual-tone', 'Dual-tone clear', 'Thicker two-tone clear TPU.', [], {
        colors: '4 colors', feel: 'Thick, semi-rigid clear', material: 'TPU + TPE', print: 'Back print',
      }),
      style('camera-ring', 'Camera-ring soft', 'Raised colorful camera ring on a soft shell.', [], {
        colors: 'Multiple ring colors', feel: 'Fully soft silicone', material: 'Silicone', print: 'Back print',
      }),
      style('square-edge', 'Square-edge soft', 'Straight square edges.', [], {
        colors: 'Black or white', feel: 'Fully soft silicone', material: 'Silicone', print: 'Back print',
      }),
      style('velvet-cube', 'Velvet cube', 'Soft cube shell with a lining.', [], {
        colors: 'Black or white', feel: 'Fully soft, microfiber lining', material: 'Silicone', print: 'Back print',
      }),
      style('stepped', 'Stepped camera', 'Raised camera bumper for extra camera protection.', [], {
        colors: 'Multiple colors', feel: 'Fully soft silicone', material: 'Silicone', print: 'Back print',
      }),
      style('corner-drop', 'Corner-drop clear', 'Soft clear with thicker corners. iPhone 11 through 18 Pro Max.', [{ t: '11–18 Pro Max', warn: true }], {
        colors: 'Clear', feel: 'Fully soft clear', material: 'TPU', print: 'Back print',
      }),
      style('bumper-plated', 'Bumper plated', 'Thick TPU with plated corners. Gold plating is no longer made.', [], {
        colors: 'Plated corners, not gold', feel: 'Thick, semi-rigid', material: 'TPU', print: 'Back print + plating',
      }),
      style('macaron', 'Macaron silicone', 'Liquid silicone with a lining. iPhone 15 through 18 Pro Max only.', [{ t: '15–18 Pro Max', warn: true }], {
        feel: 'Liquid silicone, microfiber lining', material: 'Liquid silicone + acrylic', print: 'Inner print',
      }),
    ],
  },
];

const SAMSUNG_STYLES = [
  style('clear-soft', 'Clear soft', 'Flexible clear TPU. Bright print on the back.', [], {
    colors: 'Clear · precise or large hole', feel: 'Fully soft clear', material: 'TPU', print: 'Back print',
  }),
  style('full-wrap', 'Full-wrap film', 'The thinnest wrap. Print continues around the edges.', ['Wrap'], {
    colors: 'Your artwork · gloss or matte · precise or large hole', feel: 'Ultra-thin, hard', material: 'PC film', print: 'Full wrap',
  }),
  style('glass-back', 'Glass back', 'Poster look on hard glass.', [], {
    colors: 'Black bumper', feel: 'Soft bumper, rigid back', material: 'Glass + PC + TPU', print: 'Back print',
  }),
  style('stepped', 'Stepped camera', 'Raised camera bumper for extra protection on Galaxy.', [], {
    colors: 'Multiple colors', feel: 'Fully soft silicone', material: 'Silicone', print: 'Back print',
  }),
  style('magsafe-clear', 'MagSafe clear', 'Clear MagSafe case. Galaxy S-series only.', [{ t: 'S-series only', warn: true }], {
    magsafe: true, colors: 'Clear', feel: 'Soft bumper, rigid back', material: 'Acrylic + TPU', print: 'Back print',
  }),
  style('dual-wrap', 'Dual-layer wrap', 'Glossy wrap. Galaxy S21 through S26 Ultra only.', [{ t: 'S21–S26 Ultra', warn: true }, 'Wrap'], {
    colors: 'Your artwork · gloss only', feel: 'Soft inside, hard outside, slight curve', material: 'TPU + PC', print: 'Full wrap',
  }),
];

let appleStyleNo = 1;
for (const page of APPLE_PAGES) {
  for (const st of page.styles) {
    st.num = appleStyleNo;
    appleStyleNo += 1;
  }
}
SAMSUNG_STYLES.forEach((st, i) => {
  st.num = i + 1;
});

const APPLE_MODELS = [
  { heading: 'iPhone 18', names: ['iPhone 18 Pro', 'iPhone 18 Pro Max'] },
  { heading: 'iPhone 17', names: ['iPhone 17', 'iPhone Air', 'iPhone 17 Pro', 'iPhone 17 Pro Max'] },
  { heading: 'iPhone 16', names: ['iPhone 16', 'iPhone 16 Plus', 'iPhone 16 Pro', 'iPhone 16 Pro Max'] },
  { heading: 'iPhone 15', names: ['iPhone 15', 'iPhone 15 Pro', 'iPhone 15 Pro Max', 'iPhone 14/15 Plus'] },
  { heading: 'iPhone 13 / 14', names: ['iPhone 13/14', 'iPhone 14 Pro', 'iPhone 14 Pro Max', 'iPhone 13 Pro', 'iPhone 13 Pro Max'] },
  { heading: 'iPhone 12', names: ['iPhone 12/12 Pro', 'iPhone 12 Pro Max'] },
  { heading: 'iPhone 11', names: ['iPhone 11', 'iPhone 11 Pro', 'iPhone 11 Pro Max'] },
];

const SAMSUNG_MODELS = [
  { heading: 'Galaxy S26', names: ['Samsung Galaxy S26', 'Samsung Galaxy S26+', 'Samsung Galaxy S26 Ultra'] },
  { heading: 'Galaxy S25', names: ['Samsung Galaxy S25', 'Samsung Galaxy S25+', 'Samsung Galaxy S25 Ultra', 'Samsung Galaxy S25 FE', 'Samsung Galaxy S25 Edge'] },
  { heading: 'Galaxy S24', names: ['Samsung Galaxy S24', 'Samsung Galaxy S24+', 'Samsung Galaxy S24 Ultra', 'Samsung Galaxy S24 FE'] },
  { heading: 'Galaxy S23', names: ['Samsung Galaxy S23', 'Samsung Galaxy S23+', 'Samsung Galaxy S23 Ultra', 'Samsung Galaxy S23 FE'] },
  { heading: 'Galaxy S22', names: ['Samsung Galaxy S22', 'Samsung Galaxy S22+', 'Samsung Galaxy S22 Ultra'] },
];

/** Excel data row (1-based) → buyer image id. Accessories and blank-model acrylics omitted. */
const EXCEL_ROW_IDS = {
  3: 'lambskin',
  4: 'glass-back',
  5: 'liquid-paint-glass',
  6: 'metallic-glass',
  7: 'aurora-glass',
  8: 'clear-soft',
  9: 'full-wrap',
  10: 'soft-wrap',
  11: 'dual-wrap',
  12: 'magsafe-wrap',
  13: 'camera-ring',
  14: 'square-edge',
  15: 'clear-acrylic',
  16: 'velvet-cube',
  17: 'acrylic-mirror',
  18: 'iridescent',
  19: 'dual-tone',
  20: 'black-frame-acrylic',
  21: 'stepped',
  22: 'jelly',
  23: 'cream',
  24: 'space-clear',
  25: 'frosted-glass',
  26: 'large-cut-glass',
  27: 'frosted-acrylic',
  28: 'large-frame-mirror',
  29: 'bumper-plated',
  30: 'magsafe-clear',
  34: 'wave-wrap',
  35: 'corner-drop',
  36: 'crystal-glaze',
  37: 'grooved-acrylic',
  39: 'macaron',
};

function allAppleStyles() {
  return APPLE_PAGES.reduce((list, page) => list.concat(page.styles), []);
}

function skuCode(n) {
  return String(n).padStart(2, '0');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function factsHtml(st) {
  const rows = [];
  if (st.colors) rows.push(['Color', st.colors]);
  if (st.feel) rows.push(['Feel', st.feel]);
  if (st.material) rows.push(['Material', st.material]);
  if (st.print) rows.push(['Print', st.print]);
  if (st.magsafe) rows.push(['MagSafe', 'Built-in']);
  if (!rows.length) return '';
  return `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function chipHtml(chip) {
  if (typeof chip === 'string') return `<span class="chip">${esc(chip)}</span>`;
  const cls = chip.warn ? 'chip warn' : chip.soft ? 'chip soft' : 'chip';
  return `<span class="${cls}">${esc(chip.t)}</span>`;
}

function photoMedia(st) {
  if (st.photoFit === 'contain') {
    const box = st.photoBox || { w: 720, h: 1610 };
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${box.w} ${box.h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(st.name)}"><image href="${esc(st.img)}" xlink:href="${esc(st.img)}" width="${box.w}" height="${box.h}" /></svg>`;
  }
  return `<img src="${esc(st.img)}" alt="${esc(st.name)}">`;
}

function cardHtml(st, opts) {
  const dense = opts && opts.dense;
  const feature = opts && opts.feature;
  const cls = ['card', dense ? 'stack' : '', feature ? 'feature' : '', st.magsafe ? 'magsafe' : ''].filter(Boolean).join(' ');
  const note = st.blank ? '<span class="photo-note">Shown unprinted</span>' : '';
  const badge = st.magsafe ? '<span class="ms-badge">MagSafe</span>' : '';
  const photoCls = st.photoFit === 'contain' ? 'card-photo fullcase' : 'card-photo';
  return `<article class="${cls}">
        <div class="${photoCls}">
          <span class="sku">${skuCode(st.num)}</span>
          ${badge}
          ${note}
          ${photoMedia(st)}
        </div>
        <div class="card-body">
          <h3>${esc(st.name)}</h3>
          ${dense ? '' : `<p>${esc(st.blurb)}</p>`}
          ${factsHtml(st)}
          ${st.chips.length ? `<div class="chips">${st.chips.map(chipHtml).join('')}</div>` : ''}
        </div>
      </article>`;
}

function orderCardHtml(kind) {
  const phone = kind === 'samsung' ? 'Samsung Galaxy S24 Ultra' : 'iPhone 12 Pro Max';
  const styleLine = kind === 'samsung'
    ? '<em>No. 02</em> Full-wrap film'
    : '<em>No. 03</em> Full-wrap film';
  return `<aside class="order">
      <div class="order-kicker">How to reply</div>
      <dl>
        <div><dt>Phone</dt><dd>${esc(phone)}</dd></div>
        <div><dt>Style</dt><dd>${styleLine}</dd></div>
        <div><dt>Color</dt><dd>If the card lists one</dd></div>
        <div><dt>Art</dt><dd>PNG or JPG in this chat</dd></div>
      </dl>
    </aside>`;
}

function stepsHtml(kind) {
  const steps = [
    { icon: 'icons/step-phone.png', n: '01', title: 'Phone', hint: kind === 'samsung' ? 'Galaxy from page 2' : 'iPhone from page 5' },
    { icon: 'icons/step-style.png', n: '02', title: 'Style', hint: kind === 'samsung' ? 'Number, like 02' : 'Number, like 03' },
    { icon: 'icons/step-art.png', n: '03', title: 'Art', hint: 'PNG or JPG here' },
    { icon: 'icons/step-revisions.png', n: '04', title: '2 revisions', hint: 'Two proof changes' },
    { icon: 'icons/step-pay.png', n: '05', title: 'Pay', hint: 'Checkout on Etsy' },
  ];
  return `<nav class="process" aria-label="How to order">
      ${steps.map((s) => `<div class="step">
        <span class="n">${esc(s.n)}</span>
        <img src="${esc(s.icon)}" alt="">
        <div class="step-copy">
          <b>${esc(s.title)}</b>
          <span class="hint">${esc(s.hint)}</span>
        </div>
      </div>`).join('\n      ')}
    </nav>`;
}

function modelsHtml(groups, help) {
  const cards = groups.map((g) => `<div class="model-group">
        <h2>${esc(g.heading)}</h2>
        <div class="model-list">${g.names.map((n) => `<span class="model">${esc(n)}</span>`).join('')}</div>
      </div>`).join('\n      ');
  const note = help
    ? `\n      <div class="help"><b>How to write it</b><p>${esc(help)}</p></div>`
    : '';
  return cards + note;
}

function indexHtml(styles) {
  const few = styles.length <= 8;
  const items = styles.map((st) => {
    if (few) {
      return `<li><span class="sku">${skuCode(st.num)}</span><span class="idx-copy"><b>${esc(st.name)}${st.magsafe ? ' <span class="ms">MagSafe</span>' : ''}</b><span class="sub">${esc(st.blurb)}</span></span></li>`;
    }
    return `<li><span class="sku">${skuCode(st.num)}</span> ${esc(st.name)}${st.magsafe ? ' <span class="ms">MagSafe</span>' : ''}</li>`;
  }).join('\n        ');
  const example = few
    ? `<div class="index-example"><b>Example reply</b><p>1. Samsung Galaxy S24 Ultra</p><p>2. <em>No. 02</em> Full-wrap film, gloss</p><p>3. PNG or JPG attached</p><p class="color-note">Add a color if the card lists one.</p></div>`
    : '';
  return `<div class="index${few ? ' few' : ''}">
      <h2>Style index</h2>
      <ol>
        ${items}
      </ol>
      ${example}
    </div>`;
}

function documentHead(title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="lookbook.css">
</head>
<body>`;
}

function pageCardsHtml(page) {
  const gridCls = page.dense ? 'grid grid-3' : 'grid';
  if (page.groups) {
    return `<div class="bands">
    ${page.groups.map((g) => {
      const slice = page.styles.slice(g.from, g.to);
      const bandCls = g.magsafe ? 'band band-ms' : 'band band-wrap';
      return `<section class="${bandCls}">
      <div class="band-head"><b>${esc(g.label)}</b><span>${esc(g.note)}</span></div>
      <div class="grid">
        ${slice.map((st) => cardHtml(st, {})).join('\n        ')}
      </div>
    </section>`;
    }).join('\n    ')}
    </div>`;
  }
  const cards = page.styles.map((st, j) => cardHtml(st, {
    dense: page.dense,
    feature: page.featureLast && j === page.styles.length - 1,
  })).join('\n      ');
  return `<div class="${gridCls}">
      ${cards}
    </div>`;
}

function renderAppleHtml() {
  const total = APPLE_PAGES.length + 1;
  const pages = APPLE_PAGES.map((page, i) => {
    const intro = page.steps ? `${stepsHtml('apple')}\n    ${orderCardHtml('apple')}` : '';
    const kicker = page.kicker ? `<p class="kicker">${esc(page.kicker)}</p>` : '';
    const footLeft = page.contents || `Page ${i + 1} of ${total}`;
    return `  <section class="page">
    <div class="topbar">
      <img class="brand-mark" src="logo.jpg" alt="Y2KASE">
      <div class="meta">${esc(page.meta)}</div>
    </div>
    ${kicker}
    <h1>${esc(page.title)}</h1>
    <p class="lede">${esc(page.lede)}</p>
    ${intro}
    ${pageCardsHtml(page)}
    <div class="foot">
      <span>${esc(footLeft)}</span>
      <span>Payment stays on Etsy</span>
    </div>
  </section>`;
  });

  pages.push(`  <section class="page page-directory">
    <div class="topbar">
      <img class="brand-mark" src="logo.jpg" alt="Y2KASE">
      <div class="meta">Models · index</div>
    </div>
    <p class="kicker">iPhone · compatibility</p>
    <h1>iPhones we print</h1>
    <p class="lede">Reply with the exact name from this list. MagSafe is No. 01 and No. 02 only. Pink tags on earlier pages mark styles that skip some models. The listing dropdown is the final check.</p>
    <div class="directory">
      <div class="models">
        ${modelsHtml(APPLE_MODELS, 'Copy the chip text, not a nickname. Mini and 11 Pro are skipped on some styles — those pink tags are on the photos. The listing dropdown is the final check.')}
      </div>
      ${indexHtml(allAppleStyles())}
    </div>
    <div class="foot">
      <span>Page ${total} of ${total}</span>
      <span>Payment stays on Etsy</span>
    </div>
  </section>`);

  return `${documentHead('Y2KASE Custom iPhone Case Menu')}
${pages.join('\n\n')}
</body>
</html>
`;
}

function renderSamsungHtml() {
  const cards = SAMSUNG_STYLES.map((st) => cardHtml(st, {})).join('\n      ');
  return `${documentHead('Y2KASE Custom Galaxy Case Menu')}
  <section class="page">
    <div class="topbar">
      <img class="brand-mark" src="logo.jpg" alt="Y2KASE">
      <div class="meta">Collection 01–06</div>
    </div>
    <p class="kicker">Galaxy S-series · custom print</p>
    <h1>Galaxy S-series cases</h1>
    <p class="lede">Six constructions for selected Galaxy S phones. MagSafe is No. 05 only, and only on Galaxy S-series. Each card lists color, feel, material, and print.</p>
    ${stepsHtml('samsung')}
    ${orderCardHtml('samsung')}
    <div class="grid">
      ${cards}
    </div>
    <div class="foot">
      <span>01–06 Galaxy styles  ·  Models p.2</span>
      <span>Payment stays on Etsy</span>
    </div>
  </section>

  <section class="page page-directory">
    <div class="topbar">
      <img class="brand-mark" src="logo.jpg" alt="Y2KASE">
      <div class="meta">Models · index</div>
    </div>
    <p class="kicker">Galaxy · compatibility</p>
    <h1>Galaxy phones we print</h1>
    <p class="lede">S-series on this menu. MagSafe is No. 05 only. Flip, Fold, A-series, and Pixel are not included unless the listing names them. Dual-wrap is S21 through S26 Ultra only.</p>
    <div class="directory">
      <div class="models">
        ${modelsHtml(SAMSUNG_MODELS, 'S-series only on this menu. Flip, Fold, A-series, and Pixel are not included unless the listing names them. MagSafe clear is S-series only. Dual-wrap is S21 through S26 Ultra only.')}
      </div>
      ${indexHtml(SAMSUNG_STYLES)}
    </div>
    <div class="foot">
      <span>Page 2 of 2</span>
      <span>Payment stays on Etsy</span>
    </div>
  </section>
</body>
</html>
`;
}

function listingShell(title, css, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(title)}</title>
  <style>
    @font-face { font-family: Fredoka; src: url("fonts/Fredoka-variable.ttf") format("truetype"); font-weight: 300 700; }
    html, body { margin: 0; width: 2000px; height: 2000px; overflow: hidden; font-family: Fredoka, sans-serif; font-variant-ligatures: none; color: #4a1848; background: linear-gradient(180deg, #ffe6f8, #ead9ff 50%, #d4f3ff); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ${css}
  </style>
</head>
<body>
${body}
</body>
</html>
`;
}

function renderListingAppleHtml() {
  const items = allAppleStyles().map((st) => {
    const extras = [st.photoFit === 'contain' ? 'contain' : '', st.magsafe ? 'magsafe' : ''].filter(Boolean).join(' ');
    const badge = st.magsafe ? '<span class="ms-badge">MagSafe</span>' : '';
    return `<div class="tile${extras ? ` ${extras}` : ''}"><span class="sku">${skuCode(st.num)}</span>${badge}<img src="${esc(st.img)}" alt=""><b>${esc(st.name)}</b></div>`;
  }).join('\n      ');
  const css = `
    .frame { box-sizing: border-box; width: 2000px; height: 2000px; padding: 32px 40px 36px; display: flex; flex-direction: column; }
    .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .top img { height: 96px; width: auto; object-fit: contain; }
    .meta { font-size: 16px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ff2f9f; }
    h1 { font-size: 44px; font-weight: 700; color: #ff2f9f; margin: 0 0 6px; letter-spacing: -0.02em; }
    .lede { font-size: 22px; font-weight: 500; margin: 0 0 16px; line-height: 1.35; color: #5a2458; }
    .lede em { font-style: normal; font-weight: 700; color: #ff2f9f; }
    .grid { display: grid; grid-template-columns: repeat(6, 1fr); grid-template-rows: repeat(6, 1fr); gap: 12px; flex: 1; min-height: 0; }
    .tile { position: relative; background: #fff; border: 2px solid #ffc2e4; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
    .sku { position: absolute; top: 8px; left: 8px; z-index: 1; min-width: 40px; height: 28px; padding: 0 8px; border-radius: 8px; background: #ff2f9f; color: #fff; font-size: 16px; font-weight: 700; display: flex; align-items: center; justify-content: center; letter-spacing: 0.04em; }
    .tile img { width: 100%; flex: 1; min-height: 0; object-fit: cover; background: #fff5fb; }
    .tile.contain img { object-fit: contain; background: #fff5fb; }
    .tile.magsafe { border-color: #ff2f9f; }
    .ms-badge { position: absolute; top: 8px; right: 8px; z-index: 1; background: #4a1848; color: #fff; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 4px 8px; border-radius: 7px; }
    .tile b { display: block; padding: 8px 8px 10px; font-size: 17px; font-weight: 650; color: #4a1848; text-align: center; line-height: 1.15; }
    .tile.cta { grid-column: span 3; background: #ff2f9f; border-color: #ff2f9f; align-items: center; justify-content: center; }
    .tile.cta b { color: #fff; font-size: 30px; padding: 0; }
  `;
  const body = `  <div class="frame">
    <div class="top"><img src="logo.jpg" alt="Y2KASE"><div class="meta">iPhone · 33 styles</div></div>
    <h1>The iPhone collection</h1>
    <p class="lede">Sample print shown. MagSafe is <em>No. 01</em> and <em>No. 02</em> only. Each PDF card lists color, feel, material, and print. Reply with your iPhone, the style number, and a color if the card lists one.</p>
    <div class="grid">
      ${items}
      <div class="tile cta"><b>All 33 styles · PDF menu</b></div>
    </div>
  </div>`;
  return listingShell('Y2KASE iPhone styles', css, body);
}

function renderListingSamsungHtml() {
  const cards = SAMSUNG_STYLES.map((st) => {
    const warn = st.chips.find((c) => c && c.warn);
    const tag = warn ? `<span class="tag">${esc(warn.t)}</span>` : '';
    const badge = st.magsafe ? '<span class="ms-badge">MagSafe</span>' : '';
    return `<div class="card${st.magsafe ? ' magsafe' : ''}"><div class="photo"><span class="sku">${skuCode(st.num)}</span>${badge}<img src="${esc(st.img)}" alt=""></div><div class="body"><h2>${esc(st.name)}</h2><p>${esc(st.blurb)}</p>${factsHtml(st)}${tag}</div></div>`;
  }).join('\n      ');
  const css = `
    .frame { box-sizing: border-box; width: 2000px; height: 2000px; padding: 40px 54px 44px; display: flex; flex-direction: column; }
    .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .top img { height: 130px; width: auto; object-fit: contain; }
    .meta { font-size: 18px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ff2f9f; }
    h1 { font-size: 56px; font-weight: 700; color: #ff2f9f; margin: 0 0 8px; letter-spacing: -0.02em; }
    .lede { font-size: 26px; font-weight: 500; margin: 0 0 18px; line-height: 1.35; color: #5a2458; }
    .lede em { font-style: normal; font-weight: 700; color: #ff2f9f; }
    .warn { background: #fff; color: #4a1848; border: 3px solid #ff2f9f; padding: 14px 22px; font-size: 22px; font-weight: 600; border-radius: 16px; margin-bottom: 18px; text-align: center; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; flex: 1; min-height: 0; }
    .card { background: #fff; border: 2px solid #ffc2e4; border-radius: 22px; overflow: hidden; display: grid; grid-template-columns: 46% 1fr; }
    .photo { position: relative; min-height: 0; }
    .sku { position: absolute; top: 12px; left: 12px; z-index: 1; min-width: 52px; height: 36px; padding: 0 10px; border-radius: 10px; background: #ff2f9f; color: #fff; font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center; letter-spacing: 0.04em; }
    .card img { width: 100%; height: 100%; object-fit: cover; object-position: center; background: #fff5fb; }
    .body { padding: 22px 26px; display: flex; flex-direction: column; justify-content: center; }
    h2 { font-size: 30px; font-weight: 650; margin: 0 0 6px; color: #ff2f9f; }
    p { margin: 0 0 10px; font-size: 20px; font-weight: 500; line-height: 1.3; color: #5a2458; }
    .facts { margin: 0 0 10px; display: grid; gap: 4px; }
    .facts div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; align-items: baseline; }
    .facts dt { font-size: 14px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #7a4aa0; }
    .facts dd { margin: 0; font-size: 20px; font-weight: 550; color: #4a1848; line-height: 1.25; }
    .card.magsafe { border-color: #ff2f9f; }
    .ms-badge { position: absolute; top: 12px; right: 12px; z-index: 1; background: #4a1848; color: #fff; font-size: 16px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 6px 10px; border-radius: 8px; }
    .tag { display: inline-block; margin-top: 4px; font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: #ff2f9f; color: #fff; padding: 5px 12px; border-radius: 999px; }
  `;
  const body = `  <div class="frame">
    <div class="top"><img src="logo.jpg" alt="Y2KASE"><div class="meta">Galaxy · 6 styles</div></div>
    <h1>Galaxy S-series cases</h1>
    <p class="lede">MagSafe is <em>No. 05</em> only, and only on Galaxy S-series. Each card lists color, feel, material, and print. Reply with your Galaxy, the style number, and a color if the card lists one.</p>
    <div class="warn">MagSafe is No. 05 only (S-series). Dual-wrap is S21 through S26 Ultra only.</div>
    <div class="grid">
      ${cards}
    </div>
  </div>`;
  return listingShell('Y2KASE Galaxy styles', css, body);
}

function renderListingModelsHtml(kind) {
  const isSamsung = kind === 'samsung';
  const groups = isSamsung ? SAMSUNG_MODELS : APPLE_MODELS;
  const styles = isSamsung ? SAMSUNG_STYLES : allAppleStyles();
  const help = isSamsung
    ? 'Copy the chip text, not a nickname. S-series only unless the listing names Flip, Fold, A-series, or Pixel.'
    : 'Copy the chip text, not a nickname. Mini and 11 Pro are skipped on some styles — those tags are on the photos.';
  const items = groups.map((g) => `<div class="group"><h2>${esc(g.heading)}</h2><div class="list">${g.names.map((n) => `<span class="model">${esc(n)}</span>`).join('')}</div></div>`).join('\n      ');
  const few = styles.length <= 8;
  const index = styles.map((st) => few
    ? `<li><span class="sku">${skuCode(st.num)}</span><span class="idx-copy"><b>${esc(st.name)}${st.magsafe ? ' <span class="ms">MagSafe</span>' : ''}</b><span class="sub">${esc(st.blurb)}</span></span></li>`
    : `<li><span class="sku">${skuCode(st.num)}</span> ${esc(st.name)}${st.magsafe ? ' <span class="ms">MagSafe</span>' : ''}</li>`).join('');
  const title = isSamsung ? 'Galaxy phones we print' : 'iPhones we print';
  const meta = isSamsung ? 'Galaxy · models' : 'iPhone · models';
  const lede = isSamsung
    ? 'S-series on this menu. Flip, Fold, A-series, and Pixel are not included unless the listing names them.'
    : 'Reply with the exact name. The listing dropdown is the final check.';
  const note = isSamsung
    ? 'MagSafe is No. 05 only. Dual-wrap is S21 through S26 Ultra only.'
    : 'MagSafe is No. 01 and No. 02 only. Some styles skip Mini, 11 Pro, or older models — those tags are on the style photos.';
  const css = `
    .frame { box-sizing: border-box; width: 2000px; height: 2000px; padding: 36px 48px 40px; display: flex; flex-direction: column; }
    .top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .top img { height: 100px; width: auto; object-fit: contain; }
    .meta { font-size: 18px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #ff2f9f; }
    h1 { font-size: 48px; font-weight: 700; color: #ff2f9f; margin: 0 0 8px; letter-spacing: -0.02em; }
    .lede { font-size: 22px; font-weight: 500; margin: 0 0 12px; color: #5a2458; line-height: 1.35; }
    .note { background: #fff; border: 2px solid #ff2f9f; color: #4a1848; padding: 12px 18px; font-size: 20px; font-weight: 600; border-radius: 14px; margin-bottom: 16px; text-align: center; flex-shrink: 0; }
    .body { display: grid; grid-template-columns: 1.22fr 0.98fr; gap: 16px; flex: 1; min-height: 0; }
    .models { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
    .group { background: #fff; border: 2px solid #ffc2e4; border-radius: 18px; padding: 14px 18px; display: grid; grid-template-columns: 160px 1fr; gap: 12px; align-items: center; min-height: 0; flex: 1; }
    h2 { font-size: 16px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #ff2f9f; margin: 0; }
    .list { display: flex; flex-wrap: wrap; gap: 8px; }
    .model { background: #fff5fb; border: 2px solid #ffc2e4; border-radius: 999px; padding: 7px 14px; font-size: 20px; font-weight: 600; color: #4a1848; }
    .help { background: #fff5fb; border: 2px solid #ff2f9f; border-radius: 18px; padding: 18px 20px; flex: 1.2; display: flex; flex-direction: column; justify-content: center; gap: 8px; }
    .help b { font-size: 16px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #ff2f9f; }
    .help p { margin: 0; font-size: 20px; font-weight: 500; line-height: 1.35; color: #5a2458; }
    .index { background: #fff; border: 2px solid #ffc2e4; border-radius: 18px; padding: 18px 20px 20px; display: flex; flex-direction: column; min-height: 0; }
    .index h2 { margin-bottom: 12px; flex-shrink: 0; }
    .index ol { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: ${few ? '1fr' : '1fr 1fr'}; gap: ${few ? '8px' : '4px 16px'}; flex: ${few ? '0 0 auto' : '1'}; min-height: 0; grid-auto-rows: ${few ? 'auto' : '1fr'}; }
    .index li { font-size: ${few ? '20px' : '19px'}; font-weight: 550; color: #4a1848; display: flex; align-items: ${few ? 'flex-start' : 'center'}; gap: 10px; ${few ? 'background: #fff5fb; border: 2px solid #ffc2e4; border-radius: 16px; padding: 12px 14px;' : ''} }
    .idx-copy { min-width: 0; }
    .idx-copy b { display: block; font-size: ${few ? '22px' : '24px'}; font-weight: 650; }
    .sub { display: block; margin-top: 4px; font-size: 16px; font-weight: 500; color: #7a4aa0; line-height: 1.3; }
    .index-example { flex: 1; display: flex; flex-direction: column; justify-content: center; margin-top: 10px; background: #fff5fb; border: 2px solid #ff2f9f; border-radius: 16px; padding: 20px 22px; }
    .index-example b { display: block; font-size: 16px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #ff2f9f; margin-bottom: 10px; }
    .index-example p { margin: 0; font-size: 30px; font-weight: 650; line-height: 1.35; color: #4a1848; }
    .index-example p + p { margin-top: 10px; }
    .color-note { margin-top: 12px !important; font-size: 18px !important; font-weight: 550 !important; color: #7a4aa0 !important; }
    em { font-style: normal; color: #ff2f9f; }
    .sku { min-width: 36px; height: 24px; padding: 0 7px; border-radius: 7px; background: #ff2f9f; color: #fff; font-size: 14px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; letter-spacing: 0.04em; flex-shrink: 0; margin-top: ${few ? '4px' : '0'}; }
    .ms { display: inline-block; margin-left: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #fff; background: #4a1848; border-radius: 5px; padding: 2px 6px; vertical-align: middle; }
  `;
  const body = `  <div class="frame">
    <div class="top"><img src="logo.jpg" alt="Y2KASE"><div class="meta">${esc(meta)}</div></div>
    <h1>${esc(title)}</h1>
    <p class="lede">${esc(lede)}</p>
    <div class="note">${esc(note)}</div>
    <div class="body">
      <div class="models">
      ${items}
        <div class="help"><b>How to write it</b><p>${esc(help)}</p></div>
      </div>
      <div class="index${few ? ' few' : ''}">
        <h2>Style index</h2>
        <ol>${index}</ol>
        ${few ? `<div class="index-example"><b>Example reply</b><p>1. Samsung Galaxy S24 Ultra</p><p>2. <em>No. 02</em> Full-wrap film, gloss</p><p>3. PNG or JPG attached</p><p class="color-note">Add a color if the card lists one.</p></div>` : ''}
      </div>
    </div>
  </div>`;
  return listingShell(`Y2KASE ${isSamsung ? 'Galaxy' : 'iPhone'} models`, css, body);
}

/** Tuned crops from samples/_raw (already cleaned). */
const RAW_SHOTS = {
  'magsafe-wrap': {
    file: 'magsafe-wrap-cat.jpg',
    extract: { left: 900, top: 220, width: 2480, height: 5240 },
    fit: 'contain',
    width: 720,
    height: 1522,
  },
  'magsafe-clear': { file: 'magsafe-clear-0.jpg', extract: { left: 140, top: 30, width: 680, height: 820 } },
  'full-wrap': { file: 'single-film-1.jpg', extract: { left: 40, top: 10, width: 820, height: 790 } },
  'dual-wrap': { file: 'dual-film-0.jpg', extract: { left: 60, top: 20, width: 780, height: 860 } },
  'clear-soft': { file: 'clear-tpu-0.jpg', extract: { left: 50, top: 10, width: 800, height: 850 } },
  'glass-back': { file: 'glass-0.jpg', extract: { left: 308, top: 28, width: 270, height: 430 } },
  'cream': { file: 'cream-1.jpg', extract: { left: 50, top: 40, width: 800, height: 820 } },
  'lambskin': { file: 'lambskin-0.jpg', extract: { left: 8, top: 6, width: 874, height: 790 } },
  'stepped': { file: 'stepped-0.jpg', extract: { left: 20, top: 10, width: 860, height: 820 } },
};

/** ExcelJS media imageId → buyer sample. Crops hide Chinese banners where possible. */
const FACTORY_SHOTS = {
  'soft-wrap': { imageId: 14 },
  'liquid-paint-glass': { imageId: 5, extract: { left: 8, top: 18, width: 228, height: 455 } },
  'metallic-glass': { imageId: 6, extract: { left: 8, top: 18, width: 228, height: 455 } },
  'aurora-glass': { imageId: 7 },
  'camera-ring': { imageId: 20 },
  'square-edge': { imageId: 22, extract: { left: 20, top: 95, width: 960, height: 770 } },
  'clear-acrylic': { imageId: 24, extract: { left: 10, top: 58, width: 778, height: 600 } },
  'velvet-cube': { imageId: 26 },
  'acrylic-mirror': { imageId: 29 },
  'iridescent': { imageId: 31, extract: { left: 380, top: 20, width: 720, height: 1040 } },
  'dual-tone': { imageId: 32 },
  'black-frame-acrylic': { imageId: 35 },
  'jelly': { imageId: 39 },
  'space-clear': { imageId: 42 },
  'frosted-glass': { imageId: 45 },
  'large-cut-glass': { imageId: 47 },
  'frosted-acrylic': { imageId: 48 },
  'large-frame-mirror': { imageId: 50 },
  'bumper-plated': { imageId: 52 },
  'wave-wrap': { imageId: 72 },
  'corner-drop': { imageId: 62 },
  'crystal-glaze': { imageId: 64 },
  'grooved-acrylic': { imageId: 66 },
  'macaron': { imageId: 69, extract: { left: 230, top: 70, width: 500, height: 640 } },
};

module.exports = {
  APPLE_PAGES,
  SAMSUNG_STYLES,
  APPLE_MODELS,
  SAMSUNG_MODELS,
  EXCEL_ROW_IDS,
  RAW_SHOTS,
  FACTORY_SHOTS,
  allAppleStyles,
  skuCode,
  renderAppleHtml,
  renderSamsungHtml,
  renderListingAppleHtml,
  renderListingSamsungHtml,
  renderListingModelsHtml,
};
