// ---------- Estado global ----------
let currentScenario = null;
let processStart = 0;
let executedSteps = 0;
let runtimeRAF = null;

let vars = {};        // variables en tiempo real (order, auth, inventory, reply, compensation)
let events = [];      // cronología

// velocidad: 1..200 => factor 0.1x..10x (más alto = más rápido)
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

// ---------- Pasos (mapeo a BPEL) ----------
/*
  Mapeo BPEL:
  - Recibir       -> receive
  - Autorizar     -> invoke (sync)
  - Decisión      -> if
  - Reservar      -> invoke (sync)
  - Responder     -> reply
  - Reembolso (solo si falla inventario) -> compensation (deshacer efecto de invoke previo)
*/
const STEPS = [
  { id: 'receive',   name: 'Recibir Solicitud',       desc: 'Procesando solicitud entrante',  icon: 'download' },
  { id: 'payment',   name: 'Autorizar Pago',          desc: 'Autorizando proveedor de pago',  icon: 'credit_card' },
  { id: 'decision',  name: '¿Pago Aprobado?',         desc: 'Evaluando autorización',         icon: 'help' },
  { id: 'inventory', name: 'Reservar Inventario',     desc: 'Reservando elementos en stock',  icon: 'inventory_2' },
  // Paso de compensación (usado condicionalmente)
  { id: 'refund',    name: 'Reembolsar Pago (Comp.)', desc: 'Compensando pago anterior',      icon: 'undo' },
  { id: 'reply',     name: 'Responder',               desc: 'Enviando respuesta final',       icon: 'upload' },
];

// ---------- Inicialización ----------
document.addEventListener('DOMContentLoaded', () => {
  renderSteps();
  renderTimeline();
  renderVars();
  updateKPIs(0);

  // Modo oscuro
  if (localStorage.getItem('darkMode') === 'true' ||
     (!localStorage.getItem('darkMode') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }

  // Eventos
  el.darkToggle.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('darkMode', isDark);
  });

  el.btnHappy.addEventListener('click', () => run('happy'));
  el.btnReject.addEventListener('click', () => run('reject'));
  el.btnStock.addEventListener('click',  () => run('nostock'));

  el.speed.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    
    // Nueva lógica: 1..200 -> 0.1x..10x (100 => 1x)
    if (v <= 100) {
      // 1->0.1x, 100->1x (escala logarítmica para mejor control en velocidades lentas)
      speedFactor = 0.1 + (v - 1) * 0.9 / 99;
    } else {
      // 101->1.1x, 200->10x (escala más agresiva para velocidades altas)
      speedFactor = 1 + (v - 100) * 9 / 100;
    }
    
    // Mostrar el factor de velocidad con formato amigable
    el.speedVal.textContent = speedFactor < 1 
      ? (speedFactor * 100).toFixed(0) + '%'
      : speedFactor.toFixed(1) + 'x';
  });

  el.copyBtn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(
      Object.keys(vars).length ? JSON.stringify(vars, null, 2) : '{}'
    );
    const prev = el.copyBtn.innerHTML;
    el.copyBtn.innerHTML = '<span class="material-symbols-outlined text-base mr-1">check</span> ¡Copiado!';
    setTimeout(() => (el.copyBtn.innerHTML = prev), 900);
  });

  setStatus('ready');
});

// ---------- Renderizado ----------
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
    status.textContent = 'Pendiente';
    bar.style.width = '0%';
  }

  if (state === 'running') {
    root.classList.add('opacity-100','border-primary/50','bg-primary/5','dark:bg-primary/10');
    icon.classList.add('bg-status-running/20','text-status-running');
    status.classList.add('bg-status-running/20','text-status-running');
    status.textContent = 'Ejecutando';
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
        <p>Los eventos aparecerán aquí durante la ejecución del proceso</p>
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
                                                    : '{\n  // Las variables aparecerán aquí durante la ejecución\n}';
}

function setStatus(s) {
  // remove old colors
  el.statusText.classList.remove('text-status-info','text-status-ok','text-status-running','text-status-error');
  el.statusDot.classList.remove('bg-status-info','bg-status-ok','bg-status-running','bg-status-error');
  el.statusPing.classList.remove('bg-status-info','bg-status-ok','bg-status-running','bg-status-error');

  if (s==='ready') {
    el.statusText.textContent = 'Listo';
    el.statusText.classList.add('text-status-info');
    el.statusDot.classList.add('bg-status-info');
    el.statusPing.classList.add('bg-status-info');
  }
  if (s==='running') {
    el.statusText.textContent = 'Ejecutando';
    el.statusText.classList.add('text-status-running');
    el.statusDot.classList.add('bg-status-running');
    el.statusPing.classList.add('bg-status-running');
  }
  if (s==='success') {
    el.statusText.textContent = 'Finalizado';
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

// ---------- Servicios (invocaciones simuladas) ----------
function wait(ms) {
  return new Promise(res => setTimeout(res, ms / speedFactor));
}

async function paymentAuthorize(order) {
  const start = performance.now();
  // Retraso entre 400..900 ms (escalado)
  await wait(400 + Math.random()*500);
  const approved = order.amount <= 200;
  const result = {
    approved,
    authId: approved ? `AUTH_${Date.now()}` : null,
    reason: approved ? 'Pago aprobado' : 'Pago rechazado (> límite)'
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
    reason: reserved ? 'Inventario reservado' : 'Sin stock'
  };
  return { result, ms: performance.now() - start };
}

// Compensación para pago (efecto de deshacer)
async function paymentRefund(auth) {
  const start = performance.now();
  await wait(250 + Math.random()*300);
  const result = { refunded: !!auth?.authId, refundId: `REF_${Date.now()}` };
  return { result, ms: performance.now() - start };
}

// ---------- Orquestación (estilo BPEL) ----------
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

    // Paso 1 — Recibir (BPEL receive)
    const t1 = performance.now();
    setStepState('receive','running','Procesando solicitud entrante…');
    addEvent('Solicitud recibida', 'info');
    await wait(120);
    vars.order = order;
    setStepState('receive','success', 'Solicitud procesada', performance.now()-t1);
    addEvent('Solicitud procesada', 'success', performance.now()-t1);
    executedSteps++;

    // Paso 2 — Autorizar Pago (BPEL invoke)
    const t2 = performance.now();
    setStepState('payment','running','Contactando proveedor de pago…');
    addEvent('Autorización de pago iniciada', 'info');
    const { result: auth, ms: msAuth } = await paymentAuthorize(order);
    vars.auth = auth;
    if (auth.approved) {
      setStepState('payment','success','Pago autorizado', msAuth);
      addEvent('Pago autorizado', 'success', msAuth);
    } else {
      setStepState('payment','error','Pago rechazado', msAuth);
      addEvent(`Pago rechazado: ${auth.reason}`, 'error', msAuth);
    }
    executedSteps++;

    // Paso 3 — Decisión (BPEL if)
    const t3 = performance.now();
    setStepState('decision','running','Evaluando resultado del pago…');
    await wait(80);
    if (!auth.approved) {
      setStepState('decision','success','Pago no aprobado → omitir reserva', performance.now()-t3);
      addEvent('Decisión: ruta de rechazo', 'error', performance.now()-t3);

      // Paso 5 — Responder (rechazo) (BPEL reply)
      const t5r = performance.now();
      setStepState('reply','running','Enviando rechazo…');
      await wait(180);
      vars.reply = { status:'rejected', message:'Orden rechazada - pago fallido', ts:new Date().toISOString() };
      setStepState('reply','success','Rechazo enviado', performance.now()-t5r);
      addEvent('Rechazo de orden enviado', 'success', performance.now()-t5r);
      executedSteps++;

      finish(true);
      return;
    } else {
      setStepState('decision','success','Pago aprobado → continuar', performance.now()-t3);
      addEvent('Decisión: ruta aprobada', 'success', performance.now()-t3);
      executedSteps++;
    }

    // Paso 4 — Reservar Inventario (BPEL invoke)
    const t4 = performance.now();
    setStepState('inventory','running','Verificando inventario…');
    addEvent('Reserva de inventario iniciada', 'info');
    const { result: inv, ms: msInv } = await inventoryReserve(order);
    vars.inventory = inv;

    if (inv.reserved) {
      setStepState('inventory','success','Inventario reservado', msInv);
      addEvent('Inventario reservado', 'success', msInv);
      executedSteps++;

      // Paso 5 — Responder (confirmar)
      const t5 = performance.now();
      setStepState('reply','running','Enviando confirmación…');
      await wait(180);
      vars.reply = { status:'confirmed', message:'Orden confirmada', ts:new Date().toISOString() };
      setStepState('reply','success','Confirmación enviada', performance.now()-t5);
      addEvent('Confirmación de orden enviada', 'success', performance.now()-t5);
      executedSteps++;

      finish(true);
      return;
    } else {
      setStepState('inventory','error','Inventario no disponible', msInv);
      addEvent(`Inventario falló: ${inv.reason}`, 'error', msInv);
      executedSteps++;

      // *** COMPENSACIÓN *** (BPEL compensation handler)
      // Pago exitoso pero inventario falló → reembolso
      const tC = performance.now();
      setStepState('refund','running','Compensando: reembolsando pago…');
      addEvent('Compensación iniciada (reembolso)', 'info');
      const { result: comp, ms: msComp } = await paymentRefund(vars.auth);
      vars.compensation = comp;
      setStepState('refund', comp.refunded ? 'success' : 'error',
        comp.refunded ? 'Reembolso completo' : 'Reembolso falló', msComp);
      addEvent(comp.refunded ? 'Reembolso completo' : 'Reembolso falló',
               comp.refunded ? 'success' : 'error', msComp);
      executedSteps++;

      // Paso 5 — Responder (rechazar)
      const t5b = performance.now();
      setStepState('reply','running','Enviando rechazo…');
      await wait(160);
      vars.reply = { status:'rejected', message:'Orden rechazada - sin inventario (pago reembolsado)', ts:new Date().toISOString() };
      setStepState('reply','success','Rechazo enviado', performance.now()-t5b);
      addEvent('Rechazo de orden enviado', 'success', performance.now()-t5b);
      executedSteps++;

      finish(true);
      return;
    }

  } catch (e) {
    console.error(e);
    addEvent(`Proceso falló: ${e.message||e}`, 'error');
    setStatus('error');
  } finally {
    // detener ticker de tiempo de ejecución en finish()
  }
}

function finish(ok) {
  cancelAnimationFrame(runtimeRAF);
  const totalMs = performance.now() - processStart;
  updateKPIs(totalMs);
  addEvent('Proceso completado', ok?'success':'error', totalMs);
  setStatus(ok ? 'success' : 'error');
  setButtons(false);
  renderVars(); // estado final
  currentScenario = null;
}

// ---------- KPIs ----------
function updateKPIs(ms) {
  el.kpiRuntime.textContent = `${(ms/1000).toFixed(1)}s`;
  el.kpiSteps.textContent = String(executedSteps);
  el.kpiRetries.textContent = '0';
  renderVars();
}

// ---------- Funciones del Código BPEL ----------
function copyBPELCode() {
  const bpelCode = `<?xml version="1.0" encoding="UTF-8"?>
<process name="OrderProcessing" 
         targetNamespace="http://ejemplo.com/orderprocess" 
         xmlns="http://docs.oasis-open.org/wsbpel/2.0/process/executable"
         xmlns:tns="http://ejemplo.com/orderprocess"
         xmlns:client="http://cliente.ejemplo.com">

  <!-- Variables para mantener el estado del proceso -->
  <variables>
    <variable name="orderRequest" messageType="client:OrderRequest"/>
    <variable name="paymentResponse" messageType="client:PaymentResponse"/>
    <variable name="inventoryResponse" messageType="client:InventoryResponse"/>
    <variable name="orderResponse" messageType="client:OrderResponse"/>
  </variables>

  <!-- Secuencia principal del proceso -->
  <sequence>
    <!-- 1. Recibir solicitud del cliente -->
    <receive name="ReceiveOrder" 
             partnerLink="ClientLink" 
             operation="processOrder" 
             variable="orderRequest"/>

    <!-- 2. Autorizar pago -->
    <invoke name="AuthorizePayment" 
            partnerLink="PaymentLink" 
            operation="authorizePayment" 
            inputVariable="orderRequest" 
            outputVariable="paymentResponse"/>

    <!-- 3. Decisión basada en resultado del pago -->
    <if name="CheckPaymentApproval">
      <condition>$paymentResponse.approved = 'true'</condition>
      
      <!-- Pago aprobado: continuar con inventario -->
      <sequence>
        <!-- 4. Reservar inventario -->
        <invoke name="ReserveInventory" 
                partnerLink="InventoryLink" 
                operation="reserveItems" 
                inputVariable="orderRequest" 
                outputVariable="inventoryResponse"/>

        <!-- Verificar disponibilidad de inventario -->
        <if name="CheckInventoryAvailability">
          <condition>$inventoryResponse.available = 'true'</condition>
          
          <!-- Inventario disponible: confirmar orden -->
          <assign name="SetConfirmationResponse">
            <copy>
              <from literal="confirmed"/>
              <to>$orderResponse.status</to>
            </copy>
            <copy>
              <from literal="Orden confirmada exitosamente"/>
              <to>$orderResponse.message</to>
            </copy>
          </assign>
          
          <!-- Inventario no disponible: compensar pago -->
          <else>
            <compensationHandler>
              <invoke name="RefundPayment" 
                      partnerLink="PaymentLink" 
                      operation="refundPayment" 
                      inputVariable="paymentResponse"/>
            </compensationHandler>
            
            <assign name="SetRejectionResponse">
              <copy>
                <from literal="rejected"/>
                <to>$orderResponse.status</to>
              </copy>
              <copy>
                <from literal="Orden rechazada - sin inventario (pago reembolsado)"/>
                <to>$orderResponse.message</to>
              </copy>
            </assign>
          </else>
        </if>
      </sequence>
      
      <!-- Pago rechazado: rechazar orden -->
      <else>
        <assign name="SetPaymentRejectionResponse">
          <copy>
            <from literal="rejected"/>
            <to>$orderResponse.status</to>
          </copy>
          <copy>
            <from literal="Orden rechazada - pago fallido"/>
            <to>$orderResponse.message</to>
          </copy>
        </assign>
      </else>
    </if>

    <!-- 5. Enviar respuesta final al cliente -->
    <reply name="SendResponse" 
           partnerLink="ClientLink" 
           operation="processOrder" 
           variable="orderResponse"/>
  </sequence>
</process>`;

  navigator.clipboard.writeText(bpelCode).then(() => {
    // Cambiar el texto del botón temporalmente
    const copyBtn = document.querySelector('[onclick="copyBPELCode()"]');
    const originalText = copyBtn.innerHTML;
    copyBtn.innerHTML = '<span class="material-symbols-outlined text-base mr-1">check</span> ¡Copiado!';
    copyBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    copyBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
    
    setTimeout(() => {
      copyBtn.innerHTML = originalText;
      copyBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
      copyBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
    }, 2000);
  }).catch(err => {
    console.error('Error al copiar código BPEL:', err);
    alert('Error al copiar el código al portapapeles');
  });
}

function downloadBPEL() {
  const bpelCode = `<?xml version="1.0" encoding="UTF-8"?>
<process name="OrderProcessing" 
         targetNamespace="http://ejemplo.com/orderprocess" 
         xmlns="http://docs.oasis-open.org/wsbpel/2.0/process/executable"
         xmlns:tns="http://ejemplo.com/orderprocess"
         xmlns:client="http://cliente.ejemplo.com">

  <!-- Variables para mantener el estado del proceso -->
  <variables>
    <variable name="orderRequest" messageType="client:OrderRequest"/>
    <variable name="paymentResponse" messageType="client:PaymentResponse"/>
    <variable name="inventoryResponse" messageType="client:InventoryResponse"/>
    <variable name="orderResponse" messageType="client:OrderResponse"/>
  </variables>

  <!-- Secuencia principal del proceso -->
  <sequence>
    <!-- 1. Recibir solicitud del cliente -->
    <receive name="ReceiveOrder" 
             partnerLink="ClientLink" 
             operation="processOrder" 
             variable="orderRequest"/>

    <!-- 2. Autorizar pago -->
    <invoke name="AuthorizePayment" 
            partnerLink="PaymentLink" 
            operation="authorizePayment" 
            inputVariable="orderRequest" 
            outputVariable="paymentResponse"/>

    <!-- 3. Decisión basada en resultado del pago -->
    <if name="CheckPaymentApproval">
      <condition>$paymentResponse.approved = 'true'</condition>
      
      <!-- Pago aprobado: continuar con inventario -->
      <sequence>
        <!-- 4. Reservar inventario -->
        <invoke name="ReserveInventory" 
                partnerLink="InventoryLink" 
                operation="reserveItems" 
                inputVariable="orderRequest" 
                outputVariable="inventoryResponse"/>

        <!-- Verificar disponibilidad de inventario -->
        <if name="CheckInventoryAvailability">
          <condition>$inventoryResponse.available = 'true'</condition>
          
          <!-- Inventario disponible: confirmar orden -->
          <assign name="SetConfirmationResponse">
            <copy>
              <from literal="confirmed"/>
              <to>$orderResponse.status</to>
            </copy>
            <copy>
              <from literal="Orden confirmada exitosamente"/>
              <to>$orderResponse.message</to>
            </copy>
          </assign>
          
          <!-- Inventario no disponible: compensar pago -->
          <else>
            <compensationHandler>
              <invoke name="RefundPayment" 
                      partnerLink="PaymentLink" 
                      operation="refundPayment" 
                      inputVariable="paymentResponse"/>
            </compensationHandler>
            
            <assign name="SetRejectionResponse">
              <copy>
                <from literal="rejected"/>
                <to>$orderResponse.status</to>
              </copy>
              <copy>
                <from literal="Orden rechazada - sin inventario (pago reembolsado)"/>
                <to>$orderResponse.message</to>
              </copy>
            </assign>
          </else>
        </if>
      </sequence>
      
      <!-- Pago rechazado: rechazar orden -->
      <else>
        <assign name="SetPaymentRejectionResponse">
          <copy>
            <from literal="rejected"/>
            <to>$orderResponse.status</to>
          </copy>
          <copy>
            <from literal="Orden rechazada - pago fallido"/>
            <to>$orderResponse.message</to>
          </copy>
        </assign>
      </else>
    </if>

    <!-- 5. Enviar respuesta final al cliente -->
    <reply name="SendResponse" 
           partnerLink="ClientLink" 
           operation="processOrder" 
           variable="orderResponse"/>
  </sequence>
</process>`;

  // Crear elemento de descarga
  const blob = new Blob([bpelCode], { type: 'application/xml' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'OrderProcessing.bpel';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);

  // Feedback visual para el botón de descarga
  const downloadBtn = document.querySelector('[onclick="downloadBPEL()"]');
  const originalText = downloadBtn.innerHTML;
  downloadBtn.innerHTML = '<span class="material-symbols-outlined text-base mr-1">download_done</span> ¡Descargado!';
  downloadBtn.classList.add('bg-green-600', 'hover:bg-green-700');
  downloadBtn.classList.remove('bg-gray-600', 'hover:bg-gray-700');
  
  setTimeout(() => {
    downloadBtn.innerHTML = originalText;
    downloadBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
    downloadBtn.classList.add('bg-gray-600', 'hover:bg-gray-700');
  }, 2000);
}
