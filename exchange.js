'use strict';
/* 鲸鱼娘兑换屋 renderer */
const api = window.exchangeAPI;

let view = null;
let busy = false;

function fmt(n) {
  return Number(n || 0).toLocaleString('zh-CN');
}

function showMsg(text, isErr) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.style.color = isErr ? '#ff8f8f' : '#ffb86b';
}

function render() {
  if (!view) return;
  document.getElementById('usage').textContent = fmt(view.usage);
  document.getElementById('tokens').textContent = fmt(view.tokens);
  document.getElementById('affinity').textContent = `Lv.${view.level} · ${view.points} 点`;
  document.getElementById('currency').textContent = fmt(view.currency);
  // 汇率独立展示（不嵌在按钮里，避免重写按钮 textContent 时把子元素抹掉）
  document.getElementById('rate-hint').textContent = `${fmt(view.exchangeRate)} token = 1💴`;
  // 可兑换量（基于可兑换余额，好感不会因此减少）
  const canExchange = Math.floor((view.tokens || 0) / view.exchangeRate);
  document.getElementById('exchange').disabled = canExchange <= 0;
  document.getElementById('exchange').textContent = canExchange > 0
    ? `兑换 💴（可兑 ${canExchange}💴）`
    : '兑换 💴';
  // 食物列表
  const foodsEl = document.getElementById('foods');
  foodsEl.innerHTML = '';
  for (const f of view.foods || []) {
    const owned = (view.food && view.food[f.id]) || 0;
    const row = document.createElement('div');
    row.className = 'food';
    row.innerHTML = `
      <span class="emoji">${f.emoji}</span>
      <div class="info">
        <div class="name">${f.name} <span style="color:var(--dim);font-size:11px">×${owned}</span></div>
        <div class="desc">喂食好感 +${f.bonusPoints} · ${f.msg}</div>
      </div>
      <span class="price">${f.price}💴</span>
      <button class="buy" data-id="${f.id}">买</button>`;
    const buyBtn = row.querySelector('.buy');
    buyBtn.disabled = busy || view.currency < f.price;
    buyBtn.onclick = () => doBuy(f.id);
    foodsEl.appendChild(row);
  }
}

async function doBuy(id) {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await api.buy(id);
    if (!res.ok) { showMsg(res.message, true); return; }
    view = res.view;
    render();
    showMsg('✅ ' + res.message);
  } catch (err) {
    showMsg('购买出错：' + (err && err.message || err), true);
    console.error('[exchange] buy error', err);
  } finally {
    busy = false;
    render();
  }
}

async function refresh() {
  try {
    view = await api.view();
    render();
  } catch (err) {
    console.error('[exchange] refresh error', err);
    showMsg('刷新失败：' + (err && err.message || err), true);
  }
}

document.getElementById('exchange').onclick = async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    const res = await api.exchange();
    if (!res.ok) { showMsg(res.message, true); return; }
    view = res.view;
    render();
    showMsg('✅ ' + res.message);
  } catch (err) {
    showMsg('兑换出错：' + (err && err.message || err), true);
    console.error('[exchange] exchange error', err);
  } finally {
    busy = false;
    render();
  }
};

// 每 5 秒刷新一次（token 持续累积）；窗口聚焦时也立刻刷新，避免陈旧数据
setInterval(refresh, 5000);
window.addEventListener('focus', refresh);
refresh();
