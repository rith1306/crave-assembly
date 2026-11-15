import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, serverTimestamp, query, orderBy, onSnapshot, doc, getDoc, updateDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* ===== CONSTANTS ===== */
const GST_RATE = 0.05;              // 5% GST, already inside the menu prices
const DELIVERY_FEE = 49;            // flat delivery charge in rupees
const FREE_DELIVERY_ABOVE = 499;    // free delivery from this amount
const PAYMENTS = [
  { id: 'upi',  label: 'UPI' },
  { id: 'card', label: 'Card' },
  { id: 'cod',  label: 'Cash on delivery' }
];

// The life of an order. The admin moves it along; the customer watches it.
const STATUS_LABEL = {
  placed: 'Order placed',
  preparing: 'Preparing',
  out: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};
const STEPS = ['placed', 'preparing', 'out', 'delivered'];   // the progress bar steps

// What the footer shows until the admin changes it (h1d = hours row 1 days, h1t = hours row 1 time, and so on)
const DEFAULT_FOOTER = {
  tagline: 'Your own tagline here.',
  h1d: 'Mon to Fri', h1t: '10am - 9pm',
  h2d: 'Sat',        h2t: '10am - 10pm',
  h3d: 'Sunday',     h3t: 'Closed',
  address: 'Your address here',
  phone: '+91 00000 00000',
  email: 'youremail@example.com'
};

/* ===== STATE ===== */
const state = {
  menu: [],
  loading: true,
  error: '',
  cat: 'All',
  veg: false,
  cart: JSON.parse(localStorage.getItem('cart') || '{}'),   // { dishId: quantity }
  cartOpen: false,
  user: null,          // the signed-in person (null = nobody)
  admin: false,        // true when this person has a document in the 'admins' collection
  authMsg: '',         // message if sign-in fails
  step: 'cart',        // what the drawer shows: 'cart' -> 'checkout' -> 'done'
  form: { name: '', phone: '', address: '', pincode: '', payment: 'upi' },
  errors: {},          // { fieldName: 'message' }
  placing: false,      // true while the order is being saved
  orderErr: '',        // message if saving the order fails
  lastOrder: null,     // the order that was just placed
  page: 'home',        // 'home', 'menu' or 'admin'
  orders: [],          // every order (loaded only for the admin)
  adminTab: 'orders',  // 'orders', 'archive', 'menu' or 'site'
  dishForm: null,      // the Add/Edit dish form (null = closed)
  dishErr: '',         // message under the dish form
  saving: false,       // true while a dish is being saved
  menuMsg: '',         // 'Saved.' / 'Deleted.' message
  heroImage: '',       // the home page photo that is saved (a long text string, or '')
  heroDraft: '',       // a newly picked photo that is not saved yet
  siteMsg: '',         // 'Home page photo updated.' message
  siteErr: '',         // error under the home page photo box
  savingSite: false,   // true while the photo is being saved
  footer: { ...DEFAULT_FOOTER },   // the footer details that are saved
  footerForm: null,    // the footer form the admin is editing (a copy of footer)
  footerMsg: '',       // 'Footer details updated.' message
  footerErr: '',       // error under the footer form
  savingFooter: false  // true while the footer is being saved
};

// An address like ?page=menu&cat=Pizza opens straight on the menu with that category
const params = new URLSearchParams(location.search);
if (params.get('page') === 'menu') state.page = 'menu';
if (params.get('cat')) state.cat = params.get('cat');

/* ===== HELPERS ===== */
const money = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const categories = () => ['All', ...new Set(state.menu.map((m) => m.category))];

function visibleDishes() {
  return state.menu.filter((m) =>
    m.available && (state.cat === 'All' || m.category === state.cat) && (!state.veg || m.veg));
}

const saveCart = () => localStorage.setItem('cart', JSON.stringify(state.cart));

// Admin status comes from Firestore (the 'admins' collection), not from the code
const isAdmin = () => state.admin;

const orderCode = (id) => 'CRV-' + id.slice(0, 6).toUpperCase();

function cartLines() {
  return state.menu
    .filter((m) => state.cart[m.id] && m.available)
    .map((m) => ({ dish: m, qty: state.cart[m.id], total: m.price * state.cart[m.id] }));
}

const cartCount = () => cartLines().reduce((n, l) => n + l.qty, 0);

function totals() {
  const subtotal = cartLines().reduce((sum, l) => sum + l.total, 0);
  const delivery = (subtotal === 0 || subtotal >= FREE_DELIVERY_ABOVE) ? 0 : DELIVERY_FEE;
  const gst = subtotal * GST_RATE / (1 + GST_RATE);
  return { subtotal, delivery, gst, total: subtotal + delivery };
}

// Check the checkout form. Returns { field: 'message' }. An empty object means all good.
function validate(f) {
  const errors = {};
  if (f.name.trim().length < 2) errors.name = 'Please enter your full name.';
  if (!/^\d{10}$/.test(f.phone.trim())) errors.phone = 'Enter a 10-digit mobile number (digits only).';
  if (!/^\d{6}$/.test(f.pincode.trim())) errors.pincode = 'Enter a 6-digit pincode.';
  if (f.address.trim().length < 10) errors.address = 'Please enter the full delivery address.';
  return errors;
}

// Shrink a photo in the browser so it is small enough to store inside a Firestore document
function resizeImage(file, maxSide = 600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));   // never enlarge
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);   // the picture as a long text string
      if (dataUrl.length > 700000) reject(new Error('That photo is too big. Try a smaller one.'));
      else resolve(dataUrl);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image.')); };
    img.src = url;
  });
}

/* ===== VIEWS ===== */
function stepperHTML(dish, qty) {
  return `
    <div class="stepper">
      <button class="step" data-act="dec" data-a="${dish.id}" aria-label="One less ${esc(dish.name)}">-</button>
      <span class="tnum">${qty}</span>
      <button class="step" data-act="add" data-a="${dish.id}" aria-label="One more ${esc(dish.name)}">+</button>
    </div>`;
}

function dishCard(m) {
  const photo = m.image ? `<img src="${m.image}" alt="${esc(m.name)}">` : `<div class="no-photo">No photo yet</div>`;
  const qty = state.cart[m.id] || 0;
  const control = qty ? stepperHTML(m, qty) : `<button class="btn" data-act="add" data-a="${m.id}">Add</button>`;
  return `
    <article class="dish">
      <div class="dish-img">${photo}<span class="vegdot" style="--c:${m.veg ? '#1f7a4d' : '#a33a2c'}"></span></div>
      <div class="dish-body">
        <h3>${esc(m.name)}</h3>
        <p class="muted">${esc(m.desc)}</p>
        <div class="dish-meta"><span>&#9733; ${Number(m.rating).toFixed(1)}</span><span>${esc(m.category)}</span></div>
        <div class="dish-foot"><strong class="price">${money(m.price)}</strong>${control}</div>
      </div>
    </article>`;
}

function navHTML() {
  const link = (page, label) =>
    `<button class="nav-link" data-act="go" data-a="${page}" aria-current="${state.page === page}">${label}</button>`;
  const who = state.user
    ? `<span class="who">Hi, ${esc(state.user.displayName ? state.user.displayName.split(' ')[0] : 'there')}</span>
       <button class="link-light" data-act="signOut">Sign out</button>`
    : `<button class="btn btn-sm" data-act="signIn">Sign in with Google</button>`;
  // This link exists ONLY for admins
  const adminLink = isAdmin()
    ? `<button class="link-light" data-act="go" data-a="${state.page === 'admin' ? 'home' : 'admin'}">${state.page === 'admin' ? 'View site' : 'Admin'}</button>`
    : '';
  return `
    <div class="wrap nav-in">
      <button class="logo" data-act="go" data-a="home">Crave Assembly<span>.</span></button>
      <div class="nav-links">
        ${link('home', 'Home')}${link('menu', 'Menu')}
        <button class="nav-link" data-act="openCart" aria-label="Open cart, ${cartCount()} items">Cart (${cartCount()})</button>
      </div>
      <div class="nav-right">
        ${adminLink}
        ${who}
      </div>
    </div>`;
}

/* --- home page: hero + category circles --- */
function heroHTML() {
  // The photo is chosen by the admin (Admin -> Home page). No photo yet = a placeholder.
  const art = state.heroImage
    ? `<img src="${state.heroImage}" alt="Crave Assembly">`
    : `<div class="hero-art-ph">Fresh &middot; Handcrafted</div>`;
  return `
    <section class="hero">
      <div class="hero-text">
        <h1>Crave it.<br>Order it.<br><span class="g">Enjoy it.</span></h1>
        <p class="sub"><strong>Little details, huge love.</strong> Fresh, handcrafted meals from our kitchen to your door.</p>
      </div>
      <div class="hero-art">${art}</div>
    </section>`;
}

function categoryCircles() {
  const live = state.menu.filter((m) => m.available);
  const cats = [...new Set(live.map((m) => m.category))].sort();
  return cats.map((c) => {
    const withPhoto = live.find((m) => m.category === c && m.image);   // first dish of the category that has a photo
    const inside = withPhoto ? `<img src="${withPhoto.image}" alt="">` : `<b>${esc(c[0])}</b>`;
    return `<button class="circ" data-act="pickCat" data-a="${esc(c)}"><span class="disc">${inside}</span>${esc(c)}</button>`;
  }).join('');
}

function homePage() {
  return `
    ${heroHTML()}

    <section class="section center" style="padding-bottom:70px">
      <div class="orn" aria-hidden="true"><b></b><i></i><b></b></div>
      <h2 class="h-sec">Cravings worth your <em>next obsession</em></h2>
      <div class="circles">${categoryCircles()}</div>
    </section>`;
}

function footerHTML() {
  const f = state.footer;
  const rows = [[f.h1d, f.h1t, ''], [f.h2d, f.h2t, ''], [f.h3d, f.h3t, ' gold']]
    .filter(([days, time]) => days || time)            // skip a row the admin left empty
    .map(([days, time, cls]) => `<div class="hrs${cls}"><span>${esc(days)}</span><span>${esc(time)}</span></div>`).join('');
  return `
    <div class="wrap foot-grid">
      <div>
        <div class="foot-logo">Crave Assembly.</div>
        <p>${esc(f.tagline)}</p>
      </div>
      <div>
        <h4>Opening hours</h4>
        ${rows}
      </div>
      <div>
        <h4>Contact us</h4>
        <p>${esc(f.address)}</p>
        <p>${esc(f.phone)}</p>
        <p>${esc(f.email)}</p>
      </div>
    </div>
    <div class="wrap foot-bar">&copy; 2026 Crave Assembly, just a simulation.</div>`;
}

function pageHTML() {
  if (state.page === 'admin' && isAdmin()) return adminHTML();   // admins only
  if (state.loading) return '<p class="msg">Loading menu...</p>';
  if (state.error) return `<p class="msg">Could not load the menu: ${esc(state.error)}</p>`;
  if (state.page === 'home') return homePage();
  const shown = visibleDishes();
  const pills = categories().map((c) =>
    `<button class="pill" data-act="cat" data-a="${esc(c)}" aria-pressed="${state.cat === c}">${esc(c)}</button>`).join('');
  return `
    ${state.authMsg ? `<p class="msg">${esc(state.authMsg)}</p>` : ''}
    <div class="menu-top">
      <h1 class="h-page">Our menu</h1>
      <div class="veg-toggle">
        <button class="switch" role="switch" aria-checked="${state.veg}" aria-label="Veg only" data-act="toggleVeg"><span></span></button>
        <strong>Veg only</strong>
      </div>
    </div>
    <div class="cats">${pills}</div>
    <p class="muted">${shown.length} ${shown.length === 1 ? 'dish' : 'dishes'}</p>
    ${shown.length ? `<div class="grid">${shown.map(dishCard).join('')}</div>` : '<p class="msg">Nothing matches.</p>'}`;
}

/* --- admin page --- */
function orderCard(o) {
  const when = o.placedAt ? o.placedAt.toDate().toLocaleString('en-IN') : 'Just now';
  const opts = Object.entries(STATUS_LABEL).map(([id, label]) =>
    `<option value="${id}" ${o.status === id ? 'selected' : ''}>${label}</option>`).join('');
  const items = o.items.map((i) => `${i.qty} &times; ${esc(i.name)}`).join(', ');
  const pay = (PAYMENTS.find((p) => p.id === o.payment) || {}).label || '';
  return `
    <article class="order-card">
      <div class="order-top"><strong>${orderCode(o.id)}</strong><span class="muted small">${when}</span></div>
      <p>${items}</p>
      <p class="muted small">${esc(o.customer.name)} &middot; ${esc(o.customer.phone)} &middot; ${esc(o.customer.address)}, ${esc(o.customer.pincode)}</p>
      <div class="order-bottom">
        <span><strong class="tnum">${money(o.totals.total)}</strong> &middot; ${pay}</span>
        <label class="status-pick">Status <select data-order="${o.id}">${opts}</select></label>
      </div>
    </article>`;
}

// An order is "done" once it is delivered or cancelled. Done orders live in the archive.
const isDone = (o) => o.status === 'delivered' || o.status === 'cancelled';

// archive = false: new and pending orders.  archive = true: delivered (or cancelled) orders.
function ordersTab(archive) {
  const list = state.orders.filter((o) => isDone(o) === archive);
  const rows = list.length
    ? list.map(orderCard).join('')
    : `<p class="msg">${archive ? 'No delivered orders yet.' : 'No new or pending orders.'}</p>`;
  return `<div class="orders">${rows}</div><div style="height:60px"></div>`;
}

function dishFormHTML(f) {
  const cats = [...new Set(state.menu.map((m) => m.category))].map((c) => `<option value="${esc(c)}">`).join('');
  return `
    <form id="dish-form" class="card form" novalidate>
      <h2>${f.id ? 'Edit dish' : 'Add a dish'}</h2>
      <label class="field"><span>Name</span><input name="name" data-bind="dishForm" value="${esc(f.name)}"></label>
      <div class="two">
        <label class="field"><span>Category</span><input name="category" data-bind="dishForm" list="cat-list" value="${esc(f.category)}"><datalist id="cat-list">${cats}</datalist></label>
        <label class="field"><span>Price (&#8377;)</span><input name="price" data-bind="dishForm" inputmode="numeric" value="${esc(f.price)}"></label>
      </div>
      <div class="two">
        <label class="field"><span>Rating (0 to 5)</span><input name="rating" data-bind="dishForm" inputmode="decimal" value="${esc(f.rating)}"></label>
        <label class="radio"><input type="checkbox" name="veg" data-bind="dishForm" ${f.veg ? 'checked' : ''}> Vegetarian</label>
      </div>
      <label class="field"><span>Description</span><textarea name="desc" data-bind="dishForm" rows="3">${esc(f.desc)}</textarea></label>
      <div class="field"><span>Photo</span>
        <div class="photo-pick">
          <div class="thumb big">${f.image ? `<img src="${f.image}" alt="Preview">` : 'No photo'}</div>
          <input type="file" accept="image/*" data-bind="dishForm" aria-label="Choose a photo">
        </div>
      </div>
      ${state.dishErr ? `<small class="err" role="alert">${esc(state.dishErr)}</small>` : ''}
      <div class="btn-row">
        <button class="btn" type="submit" ${state.saving ? 'disabled' : ''}>${state.saving ? 'Saving...' : 'Save dish'}</button>
        <button class="link" type="button" data-act="cancelDish">Cancel</button>
      </div>
    </form>`;
}

function menuTab() {
  const top = state.dishForm ? dishFormHTML(state.dishForm) : '<button class="btn" data-act="newDish">+ Add dish</button>';
  const rows = state.menu.map((m) => `
    <div class="menu-row">
      <div class="thumb">${m.image ? `<img src="${m.image}" alt="">` : ''}</div>
      <div class="menu-info">
        <strong>${esc(m.name)}</strong> ${m.available ? '' : '<span class="tag">Hidden</span>'}<br>
        <span class="muted small">${esc(m.category)} &middot; ${money(m.price)} &middot; ${m.veg ? 'Veg' : 'Non-veg'}</span>
      </div>
      <div class="menu-actions">
        <button class="link" data-act="editDish" data-a="${m.id}">Edit</button>
        <button class="link" data-act="toggleDish" data-a="${m.id}">${m.available ? 'Hide' : 'Show'}</button>
        <button class="link danger" data-act="deleteDish" data-a="${m.id}">Delete</button>
      </div>
    </div>`).join('');
  return `
    ${state.menuMsg ? `<p class="okmsg">${esc(state.menuMsg)}</p>` : ''}
    ${top}
    <div class="menu-list">${rows || '<p class="msg">No dishes yet.</p>'}</div>
    <div style="height:60px"></div>`;
}

function siteTab() {
  const shown = state.heroDraft || state.heroImage;   // preview the new pick, else the saved one
  return `
    ${state.siteMsg ? `<p class="okmsg">${esc(state.siteMsg)}</p>` : ''}
    <div class="card form">
      <h2>Home page photo</h2>
      <p class="muted small">The big picture on the right of the home page. A wide (landscape) photo works best.</p>
      <div class="hero-art hero-prev">${shown ? `<img src="${shown}" alt="Preview">` : '<div class="hero-art-ph">No photo yet</div>'}</div>
      <input type="file" accept="image/*" data-hero="1" aria-label="Choose a home page photo">
      ${state.siteErr ? `<small class="err" role="alert">${esc(state.siteErr)}</small>` : ''}
      <div class="btn-row">
        <button class="btn" data-act="saveHero" ${!state.heroDraft || state.savingSite ? 'disabled' : ''}>${state.savingSite ? 'Saving...' : 'Save photo'}</button>
        ${state.heroImage ? '<button class="link danger" data-act="removeHero">Remove photo</button>' : ''}
      </div>
    </div>
    <div style="height:24px"></div>
    ${footerFormHTML()}
    <div style="height:60px"></div>`;
}

// The footer form: one text box per detail
function footerFormHTML() {
  const f = state.footerForm;
  const box = (label, name) =>
    `<label class="field"><span>${label}</span><input name="${name}" data-bind="footerForm" value="${esc(f[name])}"></label>`;
  return `
    <form id="footer-form" class="card form" novalidate>
      <h2>Footer details</h2>
      ${state.footerMsg ? `<p class="okmsg">${esc(state.footerMsg)}</p>` : ''}
      ${box('Tagline', 'tagline')}
      <div class="two">${box('Hours row 1: days', 'h1d')}${box('Hours row 1: time', 'h1t')}</div>
      <div class="two">${box('Hours row 2: days', 'h2d')}${box('Hours row 2: time', 'h2t')}</div>
      <div class="two">${box('Hours row 3: days', 'h3d')}${box('Hours row 3: time', 'h3t')}</div>
      ${box('Address', 'address')}
      <div class="two">${box('Phone', 'phone')}${box('Email', 'email')}</div>
      ${state.footerErr ? `<small class="err" role="alert">${esc(state.footerErr)}</small>` : ''}
      <div class="btn-row">
        <button class="btn" type="submit" ${state.savingFooter ? 'disabled' : ''}>${state.savingFooter ? 'Saving...' : 'Save footer'}</button>
      </div>
    </form>`;
}

function adminHTML() {
  const pending = state.orders.filter((o) => !isDone(o)).length;
  const archived = state.orders.length - pending;
  const tabs = [['orders', `Orders (${pending})`], ['archive', `Order archive (${archived})`], ['menu', 'Menu'], ['site', 'Home page']].map(([id, label]) =>
    `<button class="pill" data-act="adminTab" data-a="${id}" aria-pressed="${state.adminTab === id}">${label}</button>`).join('');
  const body = state.adminTab === 'menu' ? menuTab()
    : state.adminTab === 'site' ? siteTab()
    : ordersTab(state.adminTab === 'archive');
  return `
    ${state.authMsg ? `<p class="msg">${esc(state.authMsg)}</p>` : ''}
    <div class="menu-top"><h1 class="h-page">Admin</h1></div>
    <div class="cats">${tabs}</div>
    ${body}`;
}

// The progress bar the customer sees: Placed -> Preparing -> Out for delivery -> Delivered
function statusTracker(status) {
  if (status === 'cancelled') return '<p class="err">This order was cancelled.</p>';
  const at = STEPS.indexOf(status);
  return `<ol class="track">${STEPS.map((id, i) => `<li class="${i <= at ? 'on' : ''}">${STATUS_LABEL[id]}</li>`).join('')}</ol>`;
}

/* --- the drawer: three steps (cart, checkout, done) --- */
function drawerHead(title) {
  return `
    <div class="drawer-head">
      <h2>${title}</h2>
      <button class="close" data-act="closeCart" aria-label="Close">&times;</button>
    </div>`;
}

function cartLine(l) {
  const photo = l.dish.image ? `<img src="${l.dish.image}" alt="">` : '';
  return `
    <div class="line">
      <div class="line-img">${photo}</div>
      <div class="line-info">
        <h3>${esc(l.dish.name)}</h3>
        <p class="muted tnum">${money(l.dish.price)} each</p>
        ${stepperHTML(l.dish, l.qty)}
      </div>
      <div class="line-end">
        <strong class="tnum">${money(l.total)}</strong>
        <button class="link" data-act="remove" data-a="${l.dish.id}">Remove</button>
      </div>
    </div>`;
}

function cartStep() {
  const lines = cartLines();
  if (lines.length === 0) {
    return `<div class="drawer-in">${drawerHead('Your cart')}<p class="msg">Your cart is empty.</p><button class="btn" style="margin-top:18px" data-act="closeCart">Keep browsing</button></div>`;
  }
  const t = totals();
  const action = state.user
    ? `<button class="btn" data-act="checkout">Checkout</button>`
    : `<button class="btn" data-act="signIn">Sign in to checkout</button>`;
  return `
    <div class="drawer-in">
      ${drawerHead('Your cart')}
      <div class="lines">${lines.map(cartLine).join('')}</div>
      <div class="summary">
        <h2>Order summary</h2>
        <div class="row"><span>Subtotal</span><span class="tnum">${money(t.subtotal)}</span></div>
        <div class="row muted"><span>Includes GST (5%)</span><span class="tnum">${money(t.gst)}</span></div>
        <div class="row"><span>Delivery</span><span class="tnum">${t.delivery === 0 ? 'Free' : money(t.delivery)}</span></div>
        <div class="row total"><span>Total</span><span class="tnum">${money(t.total)}</span></div>
        ${t.subtotal < FREE_DELIVERY_ABOVE ? `<p class="muted small">Add ${money(FREE_DELIVERY_ABOVE - t.subtotal)} more for free delivery.</p>` : ''}
        ${action}
      </div>
    </div>`;
}

// One labelled form field. 'control' is the <input> or <textarea> HTML.
function fieldHTML(label, name, control) {
  const err = state.errors[name];
  return `
    <label class="field">
      <span>${label}</span>
      ${control}
      ${err ? `<small class="err">${esc(err)}</small>` : ''}
    </label>`;
}

function checkoutStep() {
  const f = state.form;
  const t = totals();
  const bad = (name) => (state.errors[name] ? 'aria-invalid="true"' : '');
  const radios = PAYMENTS.map((p) => `
    <label class="radio"><input type="radio" name="payment" value="${p.id}" ${f.payment === p.id ? 'checked' : ''}> ${p.label}</label>`).join('');
  const items = cartLines().map((l) => `
    <div class="row"><span>${l.qty} &times; ${esc(l.dish.name)}</span><span class="tnum">${money(l.total)}</span></div>`).join('');
  return `
    <div class="drawer-in">
      ${drawerHead('Checkout')}
      <button class="link" data-act="backToCart">&larr; Back to cart</button>
      <form id="checkout-form" class="cart-grid" novalidate>
        <div class="form">
          ${fieldHTML('Full name', 'name', `<input name="name" value="${esc(f.name)}" autocomplete="name" ${bad('name')}>`)}
          <div class="two">
            ${fieldHTML('Mobile number', 'phone', `<input name="phone" value="${esc(f.phone)}" inputmode="numeric" maxlength="10" autocomplete="tel" ${bad('phone')}>`)}
            ${fieldHTML('Pincode', 'pincode', `<input name="pincode" value="${esc(f.pincode)}" inputmode="numeric" maxlength="6" autocomplete="postal-code" ${bad('pincode')}>`)}
          </div>
          ${fieldHTML('Delivery address', 'address', `<textarea name="address" rows="3" autocomplete="street-address" ${bad('address')}>${esc(f.address)}</textarea>`)}
          <fieldset class="pay">
            <legend>Payment method</legend>
            ${radios}
            <p class="muted small">Payments are simulated. No real money is charged.</p>
          </fieldset>
        </div>
        <aside class="summary">
          <h2>Your order</h2>
          ${items}
          <div class="row muted"><span>Includes GST (5%)</span><span class="tnum">${money(t.gst)}</span></div>
          <div class="row"><span>Delivery</span><span class="tnum">${t.delivery === 0 ? 'Free' : money(t.delivery)}</span></div>
          <div class="row total"><span>Total</span><span class="tnum">${money(t.total)}</span></div>
          ${state.orderErr ? `<small class="err" role="alert">${esc(state.orderErr)}</small>` : ''}
          <button class="btn" type="submit" ${state.placing ? 'disabled' : ''}>${state.placing ? 'Placing order...' : 'Place order · ' + money(t.total)}</button>
        </aside>
      </form>
    </div>`;
}

function doneStep() {
  const o = state.lastOrder;
  const payLabel = PAYMENTS.find((p) => p.id === o.payment).label;
  const items = o.items.map((i) => `
    <div class="row"><span>${i.qty} &times; ${esc(i.name)}</span><span class="tnum">${money(i.price * i.qty)}</span></div>`).join('');
  return `
    <div class="drawer-in">
      ${drawerHead('Order placed')}
      <p class="done-id">Order <strong>${esc(o.code)}</strong></p>
      ${statusTracker(o.status)}
      <p>Thank you, ${esc(o.customer.name)}! We are preparing your food.</p>
      <p class="muted">Delivering to ${esc(o.customer.address)}, ${esc(o.customer.pincode)}</p>
      <div class="summary">
        ${items}
        <div class="row total"><span>Total</span><span class="tnum">${money(o.totals.total)}</span></div>
        <p class="muted small">Payment: ${payLabel} (simulated)</p>
      </div>
      <button class="btn" style="margin-top:18px" data-act="closeCart">Back to menu</button>
    </div>`;
}

function drawerHTML() {
  if (state.step === 'done' && state.lastOrder) return doneStep();
  if (state.step === 'checkout' && state.user) return checkoutStep();
  return cartStep();
}

/* ===== RENDER ===== */
function render() {
  document.getElementById('nav').innerHTML = navHTML();
  document.getElementById('page').innerHTML = pageHTML();
  document.getElementById('foot').innerHTML = state.page === 'admin' ? '' : footerHTML();
  document.getElementById('drawer').innerHTML = drawerHTML();
  document.getElementById('drawer').classList.toggle('open', state.cartOpen);
  document.getElementById('backdrop').classList.toggle('open', state.cartOpen);
  document.body.classList.toggle('noscroll', state.cartOpen);
}

/* ===== LOAD DATA ===== */
async function loadMenu() {
  try {
    const snap = await getDocs(collection(db, 'menu'));
    state.menu = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.menu.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    if (!categories().includes(state.cat)) state.cat = 'All';   // ignore an unknown category from the address bar
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  render();
}

// The home page photo and the footer details live in ONE document: settings/site
async function loadSite() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'site'));
    const data = snap.exists() ? snap.data() : {};
    state.heroImage = data.heroImage || '';
    state.footer = { ...DEFAULT_FOOTER, ...(data.footer || {}) };   // saved values win over the defaults
  } catch (e) { /* if it fails, the page simply shows the placeholder and default footer */ }
  render();
}

/* ===== LIVE UPDATES (Firestore pushes changes to us, no refresh needed) ===== */
let unwatchOrder = null;    // stops listening to the customer's own order
let unwatchOrders = null;   // stops listening to all orders (admin)

// Customer: follow ONE order and update the progress bar when the admin changes its status
function watchOrder(id) {
  if (unwatchOrder) unwatchOrder();
  unwatchOrder = onSnapshot(doc(db, 'orders', id), (snap) => {
    if (snap.exists() && state.lastOrder && state.lastOrder.id === id) {
      state.lastOrder.status = snap.data().status;
      render();
    }
  });
}

// Admin: follow ALL orders, newest first
function watchAllOrders() {
  if (unwatchOrders) unwatchOrders();
  unwatchOrders = onSnapshot(
    query(collection(db, 'orders'), orderBy('placedAt', 'desc')),
    (snap) => {
      state.orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    },
    (err) => { state.authMsg = 'Could not load orders: ' + err.message; render(); }
  );
}

/* ===== ADMIN: add, edit, hide and delete dishes ===== */
async function saveDish() {
  const f = state.dishForm;
  const price = Number(f.price);
  const rating = Number(f.rating);
  if (f.name.trim().length < 2) { state.dishErr = 'Please enter a dish name.'; return render(); }
  if (!f.category.trim()) { state.dishErr = 'Please enter a category.'; return render(); }
  if (!(price > 0)) { state.dishErr = 'Price must be a number above 0.'; return render(); }
  if (!(rating >= 0 && rating <= 5)) { state.dishErr = 'Rating must be between 0 and 5.'; return render(); }

  state.saving = true;
  state.dishErr = '';
  render();
  const data = {
    name: f.name.trim(), category: f.category.trim(), price, rating,
    veg: !!f.veg, desc: f.desc.trim(), image: f.image || '', available: f.available !== false
  };
  try {
    if (f.id) await setDoc(doc(db, 'menu', f.id), data);   // edit: replace this dish
    else await addDoc(collection(db, 'menu'), data);        // new dish: Firestore makes the id
    state.dishForm = null;
    state.menuMsg = 'Saved.';
    await loadMenu();                                       // reload so the list shows the change
  } catch (e) {
    state.dishErr = 'Could not save: ' + e.message;
  }
  state.saving = false;
  render();
}

/* ===== PLACE THE ORDER (saves to Firestore) ===== */
async function placeOrder() {
  if (state.placing || !state.user) return;
  state.errors = validate(state.form);
  if (Object.keys(state.errors).length > 0) {      // problems: show them and stop
    render();
    const first = document.querySelector('[aria-invalid="true"]');
    if (first) first.focus();
    return;
  }
  state.placing = true;
  state.orderErr = '';
  render();

  const f = state.form;
  const t = totals();
  const order = {
    userId: state.user.uid,
    userEmail: state.user.email,
    items: cartLines().map((l) => ({ id: l.dish.id, name: l.dish.name, price: l.dish.price, qty: l.qty })),
    totals: { subtotal: t.subtotal, delivery: t.delivery, gst: Math.round(t.gst * 100) / 100, total: t.total },
    customer: { name: f.name.trim(), phone: f.phone.trim(), address: f.address.trim(), pincode: f.pincode.trim() },
    payment: f.payment,
    status: 'placed',
    placedAt: serverTimestamp()
  };

  try {
    const ref = await addDoc(collection(db, 'orders'), order);
    state.lastOrder = {
      id: ref.id,
      code: orderCode(ref.id),
      status: 'placed',
      items: order.items, totals: order.totals, customer: order.customer, payment: order.payment
    };
    watchOrder(ref.id);
    state.cart = {};
    saveCart();
    state.step = 'done';
  } catch (e) {
    state.orderErr = 'Could not place the order: ' + e.message;
  }
  state.placing = false;
  render();
  document.getElementById('drawer').scrollTop = 0;
}

/* ===== ACTIONS ===== */
const ACT = {
  go: (page) => { state.page = page; render(); window.scrollTo(0, 0); },
  cat: (c) => { state.cat = c; render(); },
  pickCat: (c) => { state.cat = c; state.page = 'menu'; render(); window.scrollTo(0, 0); },
  toggleVeg: () => { state.veg = !state.veg; render(); },
  openCart: () => { state.cartOpen = true; render(); },
  closeCart: () => {
    state.cartOpen = false;
    if (state.step === 'done') state.step = 'cart';
    render();
  },
  add: (id) => { state.cart[id] = (state.cart[id] || 0) + 1; saveCart(); render(); },
  dec: (id) => {
    state.cart[id] = (state.cart[id] || 0) - 1;
    if (state.cart[id] <= 0) delete state.cart[id];
    saveCart(); render();
  },
  remove: (id) => { delete state.cart[id]; saveCart(); render(); },
  checkout: () => { state.step = 'checkout'; state.errors = {}; state.orderErr = ''; render(); document.getElementById('drawer').scrollTop = 0; },
  backToCart: () => { state.step = 'cart'; render(); },
  signIn: async () => {
    state.authMsg = '';
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });   // always show Google's "choose an account" screen
      await signInWithPopup(auth, provider);
    } catch (e) {
      // These two just mean "the popup was closed or replaced", so they are not real errors
      const quiet = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request'];
      if (!quiet.includes(e.code)) state.authMsg = 'Sign-in failed: ' + e.message;
      render();
    }
  },
  signOut: () => signOut(auth),

  // --- admin: tabs, home page photo, footer, menu management ---
  adminTab: (t) => {
    state.adminTab = t; state.menuMsg = ''; state.siteMsg = ''; state.siteErr = ''; state.heroDraft = '';
    state.footerMsg = ''; state.footerErr = '';
    if (t === 'site') state.footerForm = { ...state.footer };   // a copy to edit, so the live footer does not change while typing
    render();
  },
  saveHero: async () => {
    state.savingSite = true; state.siteErr = ''; render();
    try {
      await setDoc(doc(db, 'settings', 'site'), { heroImage: state.heroDraft }, { merge: true });   // merge: change only this field, keep the footer
      state.heroImage = state.heroDraft;
      state.heroDraft = '';
      state.siteMsg = 'Home page photo updated.';
    } catch (e) { state.siteErr = 'Could not save: ' + e.message; }
    state.savingSite = false; render();
  },
  removeHero: async () => {
    if (!confirm('Remove the home page photo?')) return;
    try {
      await setDoc(doc(db, 'settings', 'site'), { heroImage: '' }, { merge: true });
      state.heroImage = ''; state.heroDraft = '';
      state.siteMsg = 'Photo removed.';
    } catch (e) { state.siteErr = 'Could not remove: ' + e.message; }
    render();
  },
  saveFooter: async () => {
    const f = state.footerForm;
    const clean = {};
    for (const k of Object.keys(DEFAULT_FOOTER)) clean[k] = (f[k] || '').trim();   // trim every box
    if (!clean.tagline) { state.footerErr = 'Please enter a tagline.'; return render(); }
    if (clean.email && !/^\S+@\S+\.\S+$/.test(clean.email)) { state.footerErr = 'That email address does not look right.'; return render(); }
    state.savingFooter = true; state.footerErr = ''; state.footerMsg = ''; render();
    try {
      await setDoc(doc(db, 'settings', 'site'), { footer: clean }, { merge: true });
      state.footer = clean;
      state.footerMsg = 'Footer details updated.';
    } catch (e) { state.footerErr = 'Could not save: ' + e.message; }
    state.savingFooter = false; render();
  },
  newDish: () => {
    state.dishForm = { id: null, name: '', category: '', price: '', rating: '4.5', veg: true, desc: '', image: '', available: true };
    state.dishErr = ''; state.menuMsg = ''; render();
  },
  editDish: (id) => {
    const m = state.menu.find((x) => x.id === id);
    state.dishForm = { ...m, price: String(m.price), rating: String(m.rating) };   // a copy, so cancelling changes nothing
    state.dishErr = ''; state.menuMsg = ''; render();
  },
  cancelDish: () => { state.dishForm = null; state.dishErr = ''; render(); },
  toggleDish: async (id) => {
    const m = state.menu.find((x) => x.id === id);
    try {
      await updateDoc(doc(db, 'menu', id), { available: !m.available });
      await loadMenu();
    } catch (e) { state.authMsg = 'Could not update: ' + e.message; render(); }
  },
  deleteDish: async (id) => {
    const m = state.menu.find((x) => x.id === id);
    if (!confirm('Delete "' + m.name + '" for good?')) return;
    try {
      await deleteDoc(doc(db, 'menu', id));
      state.menuMsg = 'Deleted.';
      await loadMenu();
    } catch (e) { state.authMsg = 'Could not delete: ' + e.message; render(); }
  }
};

/* ===== EVENTS ===== */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) ACT[el.dataset.act](el.dataset.a);
});

// Every keystroke in a form field is copied into state (no re-draw, so the cursor stays put)
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.type === 'file') return;                                   // photos are handled in the 'change' listener
  if (t.dataset.bind) state[t.dataset.bind][t.name] = (t.type === 'checkbox' ? t.checked : t.value);   // admin forms (dish, footer)
  else if (t.name in state.form) state.form[t.name] = t.value;     // checkout form
});

// Pressing a submit button (or Enter in a field) submits the form
document.addEventListener('submit', (e) => {
  e.preventDefault();                              // stop the browser reloading the page
  if (e.target.id === 'checkout-form') placeOrder();
  if (e.target.id === 'dish-form') saveDish();
  if (e.target.id === 'footer-form') ACT.saveFooter();
});

// Photo pickers, and the admin's order-status dropdown
document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.type === 'file' && t.dataset.hero) {                        // admin picked a home page photo
    if (!t.files[0]) return;
    try { state.heroDraft = await resizeImage(t.files[0], 1000, 0.78); state.siteErr = ''; }
    catch (err) { state.siteErr = err.message; }
    render();
    return;
  }
  if (t.type === 'file' && t.dataset.bind === 'dishForm') {         // admin picked a dish photo
    if (!t.files[0]) return;
    try { state.dishForm.image = await resizeImage(t.files[0]); state.dishErr = ''; }
    catch (err) { state.dishErr = err.message; }
    render();
    return;
  }
  const id = t.dataset.order;                                       // admin changed an order's status
  if (!id) return;
  try {
    await updateDoc(doc(db, 'orders', id), { status: e.target.value });
  } catch (err) {
    state.authMsg = 'Could not update the order: ' + err.message;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ACT.closeCart();
});

// Runs on page load and whenever someone signs in or out
onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.admin = false;
  if (user && !state.form.name && user.displayName) state.form.name = user.displayName;   // pre-fill the name
  if (unwatchOrders) { unwatchOrders(); unwatchOrders = null; }
  render();                                          // show the signed-in navbar straight away

  if (user) {
    try {
      // Is there a document named after this person's email in 'admins'?
      const snap = await getDoc(doc(db, 'admins', (user.email || '').toLowerCase()));
      state.admin = snap.exists();
    } catch (e) { state.admin = false; }             // any problem: treat them as a normal customer
  }

  if (state.admin) {
    watchAllOrders();                                // admins get the live order list
  } else {
    state.orders = [];
    if (state.page === 'admin') state.page = 'home';
  }
  render();
});

render();
loadMenu();
loadSite();