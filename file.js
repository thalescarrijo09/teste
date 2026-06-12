import { initializeApp } from 'firebase/app';
import {
  getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, getDocs
} from 'firebase/firestore';
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'firebase/auth';

// ====================
// CONFIGURAÇÃO FIREBASE
// ====================
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ====================
// HELPERS
// ====================
const fmtMoney = (v) => (parseFloat(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDateBR = (iso) => { const [a, m, d] = (iso || '').split('-'); return d ? `${d}/${m}/${a}` : ''; };
const genSlots = (start, end, interval) => {
  const out = [];
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let cur = sh * 60 + sm;
  const endMin = eh * 60 + em;
  while (cur < endMin) {
    const h = String(Math.floor(cur / 60)).padStart(2, '0');
    const m = String(cur % 60).padStart(2, '0');
    out.push(`${h}:${m}`);
    cur += parseInt(interval);
  }
  return out;
};
const wdays = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// ====================
// ROTEAMENTO
// ====================
const page = document.body.dataset.page;
if (page === 'booking') initBooking();
else if (page === 'admin') initAdmin();

// ====================
// MÓDULO: AGENDAMENTO (index.html)
// ====================
function initBooking() {
  const state = {
    barbers: [], services: [], settings: null,
    selectedBarber: null, selectedService: null,
    selectedDate: null, selectedTime: null
  };

  const els = {
    barbersGrid: document.getElementById('barbers-grid'),
    servicesGrid: document.getElementById('services-grid'),
    datesStrip: document.getElementById('dates-strip'),
    slotsContainer: document.getElementById('slots-container'),
    slotsHelper: document.getElementById('slots-helper'),
    btnPrev: document.getElementById('prev-date'),
    btnNext: document.getElementById('next-date'),
    form: document.getElementById('booking-form'),
    msg: document.getElementById('booking-message')
  };

  // Carrega profissionais
  onSnapshot(collection(db, 'barbers'), snap => {
    state.barbers = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(b => b.active !== false);
    renderBarbers();
  });

  function renderBarbers() {
    els.barbersGrid.innerHTML = '';
    if (!state.barbers.length) return els.barbersGrid.innerHTML = '<p class="helper-text">Nenhum profissional disponível.</p>';
    state.barbers.forEach(b => {
      const card = document.createElement('div');
      card.className = 'card' + (state.selectedBarber === b.id ? ' selected' : '');
      card.innerHTML = `
        <img src="${b.photoURL || 'https://via.placeholder.com/80?text=Barber'}" alt="${b.name}" loading="lazy">
        <div class="name">${b.name}</div>
      `;
      card.onclick = () => { state.selectedBarber = b.id; state.selectedTime = null; renderBarbers(); loadSlots(); };
      els.barbersGrid.appendChild(card);
    });
  }

  // Carrega serviços
  onSnapshot(collection(db, 'services'), snap => {
    state.services = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => s.active !== false);
    renderServices();
  });

  function renderServices() {
    els.servicesGrid.innerHTML = '';
    if (!state.services.length) return els.servicesGrid.innerHTML = '<p class="helper-text">Nenhum serviço disponível.</p>';
    state.services.forEach(s => {
      const card = document.createElement('div');
      card.className = 'card' + (state.selectedService === s.id ? ' selected' : '');
      card.innerHTML = `
        <div class="name">${s.name}</div>
        <div class="price">${fmtMoney(s.price)}</div>
        <div class="duration">${s.duration} min</div>
      `;
      card.onclick = () => { state.selectedService = s.id; state.selectedTime = null; renderServices(); loadSlots(); };
      els.servicesGrid.appendChild(card);
    });
  }

  // Carrega configurações
  onSnapshot(doc(db, 'settings', 'schedule'), snap => {
    state.settings = snap.exists() ? snap.data() : { openTime: '09:00', closeTime: '19:00', intervalMinutes: 30, workDays: [1,2,3,4,5,6] };
    renderDateStrip();
  });

  let dateOffset = 0;
  const getDates = (count, offset) => {
    const out = [];
    const today = new Date();
    let attempt = 0;
    const wd = state.settings?.workDays || [1,2,3,4,5,6];
    while (out.length < count && attempt < 60) {
      const d = new Date(today); d.setDate(today.getDate() + offset + attempt);
      if (wd.includes(d.getDay())) {
        out.push({ iso: d.toISOString().slice(0,10), label: wdays[d.getDay()], num: d.getDate() });
      }
      attempt++;
    }
    return out;
  };

  function renderDateStrip() {
    const dates = getDates(10, dateOffset);
    els.datesStrip.innerHTML = '';
    dates.forEach(d => {
      const chip = document.createElement('div');
      chip.className = 'date-chip' + (state.selectedDate === d.iso ? ' selected' : '');
      chip.innerHTML = `<div class="day-label">${d.label}</div><div class="day-number">${d.num}</div>`;
      chip.onclick = () => { state.selectedDate = d.iso; state.selectedTime = null; renderDateStrip(); loadSlots(); };
      els.datesStrip.appendChild(chip);
    });
  }

  els.btnPrev.onclick = () => { if (dateOffset > 0) { dateOffset--; renderDateStrip(); } };
  els.btnNext.onclick = () => { dateOffset++; renderDateStrip(); };

  async function loadSlots() {
    if (!state.selectedBarber || !state.selectedService || !state.selectedDate) {
      els.slotsContainer.innerHTML = '<p class="helper-text">Selecione profissional, serviço e data.</p>';
      return;
    }
    const barber = state.barbers.find(b => b.id === state.selectedBarber);
    const start = barber?.startTime || state.settings?.openTime || '09:00';
    const end = barber?.endTime || state.settings?.closeTime || '19:00';
    const interval = parseInt(state.settings?.intervalMinutes || 30);
    let slots = genSlots(start, end, interval);

    try {
      const q = query(collection(db, 'appointments'), where('date', '==', state.selectedDate));
      const snap = await getDocs(q);
      const booked = snap.docs
        .map(d => d.data())
        .filter(a => a.barberId === state.selectedBarber && (a.status === 'confirmed' || a.status === 'done'))
        .map(a => a.time);
      slots = slots.filter(s => !booked.includes(s));

      els.slotsContainer.innerHTML = '';
      if (!slots.length) {
        els.slotsContainer.innerHTML = '<p class="helper-text">Nenhum horário disponível.</p>';
        return;
      }
      slots.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'slot' + (state.selectedTime === t ? ' selected' : '');
        btn.type = 'button';
        btn.textContent = t;
        btn.onclick = () => { state.selectedTime = t; loadSlots(); };
        els.slotsContainer.appendChild(btn);
      });
    } catch (err) {
      console.error(err);
      els.slotsContainer.innerHTML = '<p class="helper-text error">Erro ao carregar horários.</p>';
    }
  }

  els.form.onsubmit = async (e) => {
    e.preventDefault();
    const name = document.getElementById('customer-name').value.trim();
    const phone = document.getElementById('customer-phone').value.trim();
    if (!state.selectedBarber || !state.selectedService || !state.selectedDate || !state.selectedTime) {
      return showMsg('Complete todas as etapas.', 'error');
    }
    const srv = state.services.find(s => s.id === state.selectedService);
    try {
      await addDoc(collection(db, 'appointments'), {
        barberId: state.selectedBarber,
        serviceId: state.selectedService,
        date: state.selectedDate,
        time: state.selectedTime,
        customerName: name,
        phone,
        price: srv?.price || 0,
        status: 'confirmed',
        createdAt: new Date().toISOString()
      });
      showMsg('Agendamento confirmado com sucesso!', 'success');
      e.target.reset();
      state.selectedBarber = null; state.selectedService = null; state.selectedDate = null; state.selectedTime = null;
      renderBarbers(); renderServices(); renderDateStrip(); loadSlots();
    } catch (err) {
      showMsg('Erro: ' + err.message, 'error');
    }
  };

  function showMsg(text, type) {
    els.msg.textContent = text;
    els.msg.className = `message ${type}`;
    setTimeout(() => { els.msg.textContent = ''; els.msg.className = 'message'; }, 5000);
  }
}

// ====================
// MÓDULO: ADMIN (gestao.html)
// ====================
function initAdmin() {
  const loginScreen = document.getElementById('login-screen');
  const dashboard = document.getElementById('admin-dashboard');

  onAuthStateChanged(auth, user => {
    if (user) { loginScreen.classList.add('hidden'); dashboard.classList.remove('hidden'); startDashboard(); }
    else { loginScreen.classList.remove('hidden'); dashboard.classList.add('hidden'); }
  });

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById('login-message');
    try {
      await signInWithEmailAndPassword(auth, document.getElementById('login-email').value, document.getElementById('login-password').value);
    } catch (err) { msg.textContent = 'Erro: ' + err.message; msg.className = 'message error'; }
  };

  document.getElementById('logout-btn').onclick = () => signOut(auth);

  function startDashboard() {
    setupTabs();
    initAgenda();
    initBarbers();
    initServices();
    initSchedule();
    initFinancial();
  }

  function setupTabs() {
    document.querySelectorAll('.nav-tab').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      };
    });
  }

  // --- Agenda ---
  let unsubAgenda = null;
  function initAgenda() {
    const dateIn = document.getElementById('agenda-date');
    const barberSel = document.getElementById('agenda-barber');
    dateIn.value = new Date().toISOString().slice(0, 10);

    onSnapshot(collection(db, 'barbers'), snap => {
      const cur = barberSel.value;
      barberSel.innerHTML = '<option value="">Todos os profissionais</option>';
      snap.forEach(d => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.data().name; barberSel.appendChild(o); });
      if (cur) barberSel.value = cur;
    });

    const load = () => {
      if (unsubAgenda) unsubAgenda();
      const date = dateIn.value;
      let q = query(collection(db, 'appointments'), where('date', '==', date), orderBy('time', 'asc'));
      unsubAgenda = onSnapshot(q, snap => {
        let docs = snap.docs;
        if (barberSel.value) docs = docs.filter(d => d.data().barberId === barberSel.value);
        const list = document.getElementById('agenda-list');
        list.innerHTML = '';
        if (!docs.length) return list.innerHTML = '<p class="helper-text">Nenhum agendamento.</p>';
        docs.forEach(d => {
          const a = d.data();
          const item = document.createElement('div');
          item.className = 'list-item';
          item.innerHTML = `
            <div><strong>${a.time}</strong> — ${a.customerName}<br><small>${a.phone || '-'} | ${fmtMoney(a.price)}</small></div>
            <div class="actions">
              <span class="badge ${a.status}">${a.status}</span>
              <button class="btn btn-small btn-success" onclick="window.setStatus('${d.id}','done')">Concluir</button>
              <button class="btn btn-small btn-outline" onclick="window.setStatus('${d.id}','cancelled')">Cancelar</button>
              <button class="btn btn-small btn-danger" onclick="window.delAppt('${d.id}')">Excluir</button>
            </div>
          `;
          list.appendChild(item);
        });
      });
    };
    dateIn.onchange = load; barberSel.onchange = load; load();
  }

  window.setStatus = async (id, status) => {
    try { await updateDoc(doc(db, 'appointments', id), { status }); } catch (e) { alert(e.message); }
  };
  window.delAppt = async (id) => {
    if (!confirm('Excluir?')) return;
    try { await deleteDoc(doc(db, 'appointments', id)); } catch (e) { alert(e.message); }
  };

  // --- Profissionais ---
  function initBarbers() {
    const form = document.getElementById('barber-form');
    const list = document.getElementById('barbers-list');
    onSnapshot(collection(db, 'barbers'), snap => {
      list.innerHTML = '';
      snap.forEach(d => {
        const b = d.data();
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <div><strong>${b.name}</strong> ${b.startTime ? b.startTime + '-' + b.endTime : ''} ${b.active === false ? '(Inativo)' : ''}</div>
          <div class="actions">
            <button class="btn btn-small btn-outline" onclick="window.editBarber('${d.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.delBarber('${d.id}')">Excluir</button>
          </div>
        `;
        list.appendChild(item);
      });
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('barber-id').value;
      const data = {
        name: document.getElementById('barber-name').value,
        photoURL: document.getElementById('barber-photo').value,
        startTime: document.getElementById('barber-start').value,
        endTime: document.getElementById('barber-end').value,
        active: document.getElementById('barber-active').checked
      };
      try { id ? await updateDoc(doc(db, 'barbers', id), data) : await addDoc(collection(db, 'barbers'), data); form.reset(); document.getElementById('barber-id').value = ''; }
      catch (e) { alert(e.message); }
    };
  }
  window.editBarber = async (id) => {
    const d = await getDoc(doc(db, 'barbers', id)); if (!d.exists()) return;
    const b = d.data();
    document.getElementById('barber-id').value = id;
    document.getElementById('barber-name').value = b.name || '';
    document.getElementById('barber-photo').value = b.photoURL || '';
    document.getElementById('barber-start').value = b.startTime || '';
    document.getElementById('barber-end').value = b.endTime || '';
    document.getElementById('barber-active').checked = b.active !== false;
  };
  window.delBarber = async (id) => {
    if (!confirm('Excluir profissional?')) return;
    try { await deleteDoc(doc(db, 'barbers', id)); } catch (e) { alert(e.message); }
  };

  // --- Serviços ---
  function initServices() {
    const form = document.getElementById('service-form');
    const list = document.getElementById('services-list');
    onSnapshot(collection(db, 'services'), snap => {
      list.innerHTML = '';
      snap.forEach(d => {
        const s = d.data();
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <div><strong>${s.name}</strong> — ${fmtMoney(s.price)} (${s.duration} min) ${s.active === false ? '(Inativo)' : ''}</div>
          <div class="actions">
            <button class="btn btn-small btn-outline" onclick="window.editService('${d.id}')">Editar</button>
            <button class="btn btn-small btn-danger" onclick="window.delService('${d.id}')">Excluir</button>
          </div>
        `;
        list.appendChild(item);
      });
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const id = document.getElementById('service-id').value;
      const data = {
        name: document.getElementById('service-name').value,
        price: parseFloat(document.getElementById('service-price').value),
        duration: parseInt(document.getElementById('service-duration').value),
        active: document.getElementById('service-active').checked
      };
      try { id ? await updateDoc(doc(db, 'services', id), data) : await addDoc(collection(db, 'services'), data); form.reset(); document.getElementById('service-id').value = ''; }
      catch (e) { alert(e.message); }
    };
  }
  window.editService = async (id) => {
    const d = await getDoc(doc(db, 'services', id)); if (!d.exists()) return;
    const s = d.data();
    document.getElementById('service-id').value = id;
    document.getElementById('service-name').value = s.name || '';
    document.getElementById('service-price').value = s.price || '';
    document.getElementById('service-duration').value = s.duration || '';
    document.getElementById('service-active').checked = s.active !== false;
  };
  window.delService = async (id) => {
    if (!confirm('Excluir serviço?')) return;
    try { await deleteDoc(doc(db, 'services', id)); } catch (e) { alert(e.message); }
  };

  // --- Horários ---
  function initSchedule() {
    const form = document.getElementById('schedule-form');
    const load = async () => {
      const d = await getDoc(doc(db, 'settings', 'schedule'));
      if (d.exists()) {
        const s = d.data();
        document.getElementById('schedule-open').value = s.openTime || '09:00';
        document.getElementById('schedule-close').value = s.closeTime || '19:00';
        document.getElementById('schedule-interval').value = s.intervalMinutes || 30;
        const wd = s.workDays || [1,2,3,4,5];
        for (let i = 0; i < 7; i++) document.getElementById(`wd-${i}`).checked = wd.includes(i);
      }
    };
    load();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const workDays = [];
      for (let i = 0; i < 7; i++) if (document.getElementById(`wd-${i}`).checked) workDays.push(i);
      const data = { openTime: document.getElementById('schedule-open').value, closeTime: document.getElementById('schedule-close').value, intervalMinutes: parseInt(document.getElementById('schedule-interval').value), workDays };
      try { await setDoc(doc(db, 'settings', 'schedule'), data); showSched('Salvo!'); } catch (e) { showSched('Erro: ' + e.message, true); }
    };
    function showSched(txt, err) {
      const el = document.getElementById('schedule-status');
      el.textContent = txt; el.className = 'message ' + (err ? 'error' : 'success');
      setTimeout(() => { el.textContent = ''; el.className = 'message'; }, 4000);
    }
  }

  // --- Financeiro ---
  function initFinancial() {
    let appts = [], expenses = [];
    onSnapshot(query(collection(db, 'appointments'), where('status', '==', 'done'), orderBy('date', 'desc')), snap => {
      appts = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderFin();
    });
    onSnapshot(collection(db, 'expenses'), snap => {
      expenses = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderFin();
    });

    function renderFin() {
      const today = new Date().toISOString().slice(0, 10);
      const day = new Date().getDay();
      const diff = new Date().getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(); monday.setDate(diff);
      const weekStart = monday.toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + '-01';

      let revToday = 0, revWeek = 0, revMonth = 0, totalExp = 0;

      const list = document.getElementById('financial-list');
      list.innerHTML = '';
      appts.forEach(a => {
        const p = parseFloat(a.price) || 0;
        if (a.date === today) revToday += p;
        if (a.date >= weekStart && a.date <= today) revWeek += p;
        if (a.date >= monthStart && a.date <= today) revMonth += p;
        const row = document.createElement('div'); row.className = 'list-item';
        row.innerHTML = `<div>${fmtDateBR(a.date)} ${a.time} — ${a.customerName}</div><div><strong>${fmtMoney(p)}</strong></div>`;
        list.appendChild(row);
      });

      expenses.forEach(x => {
        const v = parseFloat(x.amount) || 0; totalExp += v;
        const row = document.createElement('div'); row.className = 'list-item';
        row.innerHTML = `<div>${fmtDateBR(x.date)} — ${x.description}</div><div><strong style="color:#ff6b6b">-${fmtMoney(v)}</strong></div>`;
        list.appendChild(row);
      });

      document.getElementById('kpi-today').textContent = fmtMoney(revToday);
      document.getElementById('kpi-week').textContent = fmtMoney(revWeek);
      document.getElementById('kpi-month').textContent = fmtMoney(revMonth);
      document.getElementById('kpi-expenses').textContent = fmtMoney(totalExp);
      document.getElementById('kpi-net').textContent = fmtMoney(revMonth - totalExp);
    }

    document.getElementById('add-expense-btn').onclick = async () => {
      const desc = document.getElementById('expense-desc').value.trim();
      const amount = parseFloat(document.getElementById('expense-amount').value);
      const date = document.getElementById('expense-date').value;
      if (!desc || !amount || !date) return alert('Preencha todos os campos da despesa.');
      try {
        await addDoc(collection(db, 'expenses'), { description: desc, amount, date, createdAt: new Date().toISOString() });
        document.getElementById('expense-desc').value = ''; document.getElementById('expense-amount').value = ''; document.getElementById('expense-date').value = '';
      } catch (e) { alert(e.message); }
    };
  }
}
