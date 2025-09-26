// ---------- Global state ----------
let currentScenario = null;
let processStart = 0;
let executedSteps = 0;
let runtimeRAF = null;

let vars = {};        // live variables (order, auth, inventory, reply, compensation)
let events = [];      // timeline

// speed: 1..100 => factor 0.5x..2x (más alto = más rápido)
let speedFactor = 1;

// ---------- DOM ----------
const el = {
  statusPing: document.getElementById('status-ping'),
  statusDot:  document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  darkToggle: document.getElementById('dark-toggle'),
  btnHappy:   document.getElementById('btn-happy'),
  btnReject:  document.getElementById('btn-reject'),
  btnStock:   document.getElementById('btn-nostock'),
  speed:      document.getElementById('speed'),
  speedVal:   document.getElementById('speed-value'),
  stepCards:  document.getElementById('step-cards'),
  timeline:   document.getElementById('timeline'),
  kpiRuntime: document.getElementById('kpi-runtime'),
  kpiSteps:   document.getElementById('kpi-steps'),
  kpiRetries: document.getElementById('kpi-retries'),
  varsPre:    document.getElementById('variables-json'),
  copyBtn:    document.getElementById('copy-json'),
};

// ---------- Steps (map to BPEL) ----------
/*
  BPEL mapping:
  - Receive       -> receive
  - Authorize     -> invoke (sync)
  - Decision      -> if
  - Reserve       -> invoke (sync)
  - Reply         -> reply
  - Refund (only inventory fail) -> compensation (undo effect of prior invoke)
*/
const STEPS = [
  { id: 'receive',   name: 'Receive Request',         desc: 'Processing incoming request',    icon: 'download' },
  { id: 'payment',   name: 'Authorize Payment',       desc: 'Authorizing payment provider',   icon: 'credit_card' },
  { id: 'decision',  name: 'Payment Approved?',       desc: 'Evaluating authorization',       icon: 'help' },
  { id: 'inventory', name: 'Reserve Inventory',       desc: 'Reserving items in stock',       icon: 'inventory_2' },
  // Compensation step (conditionally used)
  { id: 'refund',    name: 'Refund Payment (Comp.)',  desc: 'Compensating previous payment',  icon: 'undo' },
  { id: 'reply',     name: 'Reply',                   desc: 'Sending final response',         icon: 'upload' },
];

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  renderSteps();
  renderTimeline();
  renderVars();
  updateKPIs(0);

  // Dark mode
  if (localStorage.getItem('darkMode') === 'true' ||
     (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }

  // Events
  el.darkToggle.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('darkMode', isDark);
  });

  el.btnHappy.addEventListener('click', () => run('happy'));
  el.btnReject.addEventListener('click', () => run('reject'));
  el.btnStock.addEventListener('click',  () => run('nostock'));

  el.speed.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    el.speedVal.textContent = v;
    // 1..100 -> 0.5x..2x (50 => 1x)
    speedFactor = v >= 50 ? 1 + (v - 50) / 50   // 50->1, 100->2
                          : 0.5 + (v / 50) * 0.5; // 1->0.51..., 49->0.99
  });

  el.copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(
      Object.keys(vars).length ? JSON.stringify(vars, null, 2) : '{}'
    );
    const prev = el.copyBtn.innerHTML;
    el.copyBtn.innerHTML = '<span class="material-symbols-outlined text-base mr-1">check</span> Copied!';
    setTimeout(() => (el.copyBtn.innerHTML = prev), 900);
  });

  setStatus('ready');
});

// ---------- Rendering ----------
function renderSteps() {
  el.stepCards.innerHTML = STEPS.map(s => stepCardTemplate(s)).join('');
}

function stepCardTemplate(step) {
  return `
    <div id="step-${step.id}" class="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900/50 p-4 shadow-sm opacity-60">
      <div class="flex items-center gap-4">
        <div class="step-icon flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
          <span class="material-symbols-outlined text-3xl">${step.icon}</span>
        </div>
        <div class="flex-grow">
          <div class="flex justify-between items-center">
            <p class="font-bold text-gray-800 dark:text-white">${step.name}</p>
            <span class="step-status inline-flex items-center rounded-lg px-3 py-1 text-sm font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">Pending</span>
          </div>
          <p class="step-desc text-sm text-gray-600 dark:text-gray-300 mt-0.5">${step.desc}</p>
        </div>
      </div>
      <div class="mt-3 h-1 w-full rounded-full bg-gray-200 dark:bg-gray-700">
        <div class="step-bar h-1 rounded-full bg-primary" style="width:0%"></div>
      </div>
    </div>
  `;
}

function setStepState(id, state, newDesc, durationMs) {
  const root = document.getElementById(`step-${id}`);
  if (!root) return;

  const icon = root.querySelector('.step-icon');
  const status = root.querySelector('.step-status');
  const desc = root.querySelector('.step-desc');
  const bar  = root.querySelector('.step-bar');

  // reset classes
  root.classList.remove('opacity-60','border-primary/50','bg-primary/5','dark:bg-primary/10',
                        'border-status-ok/50','bg-status-ok/5',
                        'border-status-error/50','bg-status-error/5');
  icon.classList.remove('bg-status-running/20','text-status-running','bg-status-ok/20','text-status-ok','bg-status-error/20','text-status-error');
  status.classList.remove('bg-status-running/20','text-status-running','bg-status-ok/20','text-status-ok','bg-status-error/20','text-status-error');
  bar.classList.remove('bg-status-running','bg-status-ok','bg-status-error','progress-pulse');

  if (newDesc) desc.textContent = newDesc;

  if (state === 'pending') {
    root.classList.add('opacity-60');
    status.textContent = 'Pending';
    bar.style.width = '0%';
  }

  if (state === 'running') {
    root.classList.add('opacity-100','border-primary/50','bg-primary/5','dark:bg-primary/10');
    icon.classList.add('bg-status-running/20','text-status-running');
    status.classList.add('bg-status-running/20','text-status-running');
    status.textContent = 'Running';
    bar.classList.add('bg-status-running','progress-pulse');
    bar.style.width = '100%';
  }

  if (state === 'success') {
    root.classList.add('opacity-100','border-status-ok/50','bg-status-ok/5');
    icon.classList.add('bg-status-ok/20','text-status-ok');
    status.classList.add('bg-status-ok/20','text-status-ok');
    status.textContent = durationMs ? `OK • ${(durationMs/1000).toFixed(2)}s` : 'OK';
    bar.classList.add('bg-status-ok');
    bar.style.width = '100%';
  }

  if (state === 'error') {
    root.classList.add('opacity-100','border-status-error/50','bg-status-error/5');
    icon.classList.add('bg-status-error/20','text-status-error');
    status.classList.add('bg-status-error/20','text-status-error');
    status.textContent = durationMs ? `Error • ${(durationMs/1000).toFixed(2)}s` : 'Error';
    bar.classList.add('bg-status-error');
    bar.style.width = '100%';
  }
}

function addEvent(message, type='info', ms=0) {
  events.push({ id: Date.now()+Math.random(), t: new Date(), msg: message, type, ms });
  renderTimeline();
}

function renderTimeline() {
  if (!events.length) {
    el.timeline.innerHTML = `
      <li class="text-center py-8 text-gray-600 dark:text-gray-300">
        <span class="material-symbols-outlined text-4xl mb-2 opacity-50">timeline</span>
        <p>Events will appear here during process execution</p>
      </li>`;
    return;
  }

  el.timeline.innerHTML = events.map((e,i) => `
    <li>
      <div class="relative pb-8">
        ${i !== events.length-1 ? '<span aria-hidden="true" class="absolute left-4 top-4 -ml-px h-full w-0.5 bg-gray-200 dark:bg-gray-700"></span>' : ''}
        <div class="relative flex items-start space-x-3">
          <div>
            <div class="relative px-1">
              <div class="h-8 w-8 rounded-full ring-8 ring-background-light dark:ring-background-dark flex items-center justify-center
                          ${e.type==='success'?'bg-status-ok/20':e.type==='error'?'bg-status-error/20':'bg-primary/20'}">
                <span class="material-symbols-outlined text-lg
                            ${e.type==='success'?'text-status-ok':e.type==='error'?'text-status-error':'text-primary'}">
                  ${e.type==='success'?'check_circle':e.type==='error'?'error':'info'}
                </span>
              </div>
            </div>
          </div>
          <div class="min-w-0 flex-1 py-1.5">
            <div class="text-sm text-gray-700 dark:text-gray-300">
              <span class="font-medium text-gray-900 dark:text-white">${e.msg}</span>
              <span class="whitespace-nowrap"> at ${e.t.toLocaleTimeString()}</span>
              ${e.ms?`<span class="ml-1 inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium 
                     ${e.type==='success'?'bg-status-ok/20 text-status-ok':e.type==='error'?'bg-status-error/20 text-status-error':'bg-primary/20 text-primary'}">
                      ${(e.ms/1000).toFixed(2)}s
                     </span>`:''}
            </div>
          </div>
        </div>
      </div>
    </li>
  `).join('');
}

function renderVars() {
  el.varsPre.textContent = Object.keys(vars).length ? JSON.stringify(vars, null, 2)
                                                    : '{\n  // Variables will appear here during execution\n}';
}

function setStatus(s) {
  // remove old colors
  el.statusText.classList.remove('text-status-info','text-status-ok','text-status-running','text-status-error');
  el.statusDot.classList.remove('bg-status-info','bg-status-ok','bg-status-running','bg-status-error');
  el.statusPing.classList.remove('bg-status-info','bg-status-ok','bg-status-running','bg-status-error');

  if (s==='ready') {
    el.statusText.textContent = 'Ready';
    el.statusText.classList.add('text-status-info');
    el.statusDot.classList.add('bg-status-info');
    el.statusPing.classList.add('bg-status-info');
  }
  if (s==='running') {
    el.statusText.textContent = 'Running';
    el.statusText.classList.add('text-status-running');
    el.statusDot.classList.add('bg-status-running');
    el.statusPing.classList.add('bg-status-running');
  }
  if (s==='success') {
    el.statusText.textContent = 'Finished';
    el.statusText.classList.add('text-status-ok');
    el.statusDot.classList.add('bg-status-ok');
    el.statusPing.classList.add('bg-status-ok');
  }
  if (s==='error') {
    el.statusText.textContent = 'Error';
    el.statusText.classList.add('text-status-error');
    el.statusDot.classList.add('bg-status-error');
    el.statusPing.classList.add('bg-status-error');
  }
}

function setButtons(disabled) {
  [el.btnHappy, el.btnReject, el.btnStock].forEach(b => b.disabled = disabled);
}

// ---------- Services (simulated invokes) ----------
function wait(ms) {
  return new Promise(res => setTimeout(res, ms / speedFactor));
}

async function paymentAuthorize(order) {
  const start = performance.now();
  // Delay between 400..900 ms (scaled)
  await wait(400 + Math.random()*500);
  const approved = order.amount <= 200;
  const result = {
    approved,
    authId: approved ? `AUTH_${Date.now()}` : null,
    reason: approved ? 'Payment approved' : 'Payment rejected (> limit)'
  };
  return { result, ms: performance.now() - start };
}

async function inventoryReserve(order) {
  const start = performance.now();
  await wait(300 + Math.random()*500);
  const reserved = !order.orderId.endsWith('7');
  const result = {
    reserved,
    reservationId: reserved ? `RES_${Date.now()}` : null,
    reason: reserved ? 'Inventory reserved' : 'No stock'
  };
  return { result, ms: performance.now() - start };
}

// Compensation for payment (undo effect)
async function paymentRefund(auth) {
  const start = performance.now();
  await wait(250 + Math.random()*300);
  const result = { refunded: !!auth?.authId, refundId: `REF_${Date.now()}` };
  return { result, ms: performance.now() - start };
}

// ---------- Orchestration (BPEL-like) ----------
async function run(mode) {
  if (currentScenario) return;

  currentScenario = mode;
  processStart = performance.now();
  executedSteps = 0;
  vars = {};
  events = [];
  renderTimeline();
  renderVars();
  setButtons(true);
  setStatus('running');

  // Reset steps to pending
  STEPS.forEach(s => setStepState(s.id, 'pending'));

  // Keep runtime ticking
  cancelAnimationFrame(runtimeRAF);
  const tick = () => {
    const ms = performance.now() - processStart;
    updateKPIs(ms);
    runtimeRAF = requestAnimationFrame(tick);
  };
  runtimeRAF = requestAnimationFrame(tick);

  try {
    // Scenario → order (also serves as correlation key)
    const order =
      mode === 'reject' ? { orderId:'A-1002', amount:250, customerId:'C-456' } :
      mode === 'nostock' ? { orderId:'A-1007', amount:125, customerId:'C-789' } :
                           { orderId:'A-1001', amount:125, customerId:'C-123' };

    // Step 1 — Receive (BPEL receive)
    const t1 = performance.now();
    setStepState('receive','running','Processing incoming request…');
    addEvent('Request received', 'info');
    await wait(120);
    vars.order = order;
    setStepState('receive','success', 'Request processed', performance.now()-t1);
    addEvent('Request processed', 'success', performance.now()-t1);
    executedSteps++;

    // Step 2 — Authorize Payment (BPEL invoke)
    const t2 = performance.now();
    setStepState('payment','running','Contacting payment provider…');
    addEvent('Payment authorization started', 'info');
    const { result: auth, ms: msAuth } = await paymentAuthorize(order);
    vars.auth = auth;
    if (auth.approved) {
      setStepState('payment','success','Payment authorized', msAuth);
      addEvent('Payment authorized', 'success', msAuth);
    } else {
      setStepState('payment','error','Payment rejected', msAuth);
      addEvent(`Payment rejected: ${auth.reason}`, 'error', msAuth);
    }
    executedSteps++;

    // Step 3 — Decision (BPEL if)
    const t3 = performance.now();
    setStepState('decision','running','Evaluating payment result…');
    await wait(80);
    if (!auth.approved) {
      setStepState('decision','success','Payment not approved → skip reserve', performance.now()-t3);
      addEvent('Decision: reject path', 'error', performance.now()-t3);

      // Step 5 — Reply (reject) (BPEL reply)
      const t5r = performance.now();
      setStepState('reply','running','Sending rejection…');
      await wait(180);
      vars.reply = { status:'rejected', message:'Order rejected - payment failed', ts:new Date().toISOString() };
      setStepState('reply','success','Rejection sent', performance.now()-t5r);
      addEvent('Order rejection sent', 'success', performance.now()-t5r);
      executedSteps++;

      finish(true);
      return;
    } else {
      setStepState('decision','success','Payment approved → continue', performance.now()-t3);
      addEvent('Decision: approved path', 'success', performance.now()-t3);
      executedSteps++;
    }

    // Step 4 — Reserve Inventory (BPEL invoke)
    const t4 = performance.now();
    setStepState('inventory','running','Checking inventory…');
    addEvent('Inventory reservation started', 'info');
    const { result: inv, ms: msInv } = await inventoryReserve(order);
    vars.inventory = inv;

    if (inv.reserved) {
      setStepState('inventory','success','Inventory reserved', msInv);
      addEvent('Inventory reserved', 'success', msInv);
      executedSteps++;

      // Step 5 — Reply (confirm)
      const t5 = performance.now();
      setStepState('reply','running','Sending confirmation…');
      await wait(180);
      vars.reply = { status:'confirmed', message:'Order confirmed', ts:new Date().toISOString() };
      setStepState('reply','success','Confirmation sent', performance.now()-t5);
      addEvent('Order confirmation sent', 'success', performance.now()-t5);
      executedSteps++;

      finish(true);
      return;
    } else {
      setStepState('inventory','error','Inventory not available', msInv);
      addEvent(`Inventory failed: ${inv.reason}`, 'error', msInv);
      executedSteps++;

      // *** COMPENSATION *** (BPEL compensation handler)
      // Payment succeeded but inventory failed → refund
      const tC = performance.now();
      setStepState('refund','running','Compensating: refunding payment…');
      addEvent('Compensation started (refund)', 'info');
      const { result: comp, ms: msComp } = await paymentRefund(vars.auth);
      vars.compensation = comp;
      setStepState('refund', comp.refunded ? 'success' : 'error',
        comp.refunded ? 'Refund complete' : 'Refund failed', msComp);
      addEvent(comp.refunded ? 'Refund complete' : 'Refund failed',
               comp.refunded ? 'success' : 'error', msComp);
      executedSteps++;

      // Step 5 — Reply (reject)
      const t5b = performance.now();
      setStepState('reply','running','Sending rejection…');
      await wait(160);
      vars.reply = { status:'rejected', message:'Order rejected - no stock (payment refunded)', ts:new Date().toISOString() };
      setStepState('reply','success','Rejection sent', performance.now()-t5b);
      addEvent('Order rejection sent', 'success', performance.now()-t5b);
      executedSteps++;

      finish(true);
      return;
    }

  } catch (e) {
    console.error(e);
    addEvent(`Process failed: ${e.message||e}`, 'error');
    setStatus('error');
  } finally {
    // stop runtime ticker in finish()
  }
}

function finish(ok) {
  cancelAnimationFrame(runtimeRAF);
  const totalMs = performance.now() - processStart;
  updateKPIs(totalMs);
  addEvent('Process completed', ok?'success':'error', totalMs);
  setStatus(ok ? 'success' : 'error');
  setButtons(false);
  renderVars(); // final state
  currentScenario = null;
}

// ---------- KPIs ----------
function updateKPIs(ms) {
  el.kpiRuntime.textContent = `${(ms/1000).toFixed(1)}s`;
  el.kpiSteps.textContent = String(executedSteps);
  el.kpiRetries.textContent = '0';
  renderVars();
}
