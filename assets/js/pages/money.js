/** Expenses, balances and settle-up. */

import * as store from '../core/store.js';
import * as money from '../core/money.js';
import * as schedule from '../core/schedule.js';
import { escapeHtml } from '../ui/map.js';
import { mountChrome, showLoadError, onRefresh, openChangesDialog } from '../ui/nav.js';

const state = { editing: null };

async function main() {
  mountChrome();
  await store.init(['settings', 'itinerary', 'stays', 'people', 'expenses', 'rates']);

  wireDialog();
  document.getElementById('add-expense').addEventListener('click', () => openDialog(null));
  document.getElementById('add-person').addEventListener('click', addPerson);

  render();
  onRefresh(render);
}

/** Manual expenses plus the ones derived from booked lodging. */
function allExpenses() {
  return [
    ...store.get('expenses').expenses,
    ...money.derivedStayExpenses(store.get('stays'), store.get('people'), store.get('itinerary')),
  ];
}

function render() {
  const rates = store.get('rates');
  const people = store.get('people');
  const combined = allExpenses();

  renderStats(combined, people, rates);
  renderBalances(combined, people, rates);
  renderCategories(combined, rates);
  renderPeople(people, combined, rates);
  renderRates(rates);
  renderExpenses(combined, people, rates);
}

function renderStats(combined, people, rates) {
  const settings = store.get('settings');
  const forecast = money.forecast(combined, people, rates);
  const budget = settings.money.budgetPerPerson;
  const over = budget ? forecast.perPerson - budget : null;

  document.getElementById('money-stats').innerHTML = `
    ${stat('Trip total', money.formatBase(forecast.total, rates), `${forecast.headcount} people`)}
    ${stat('Per person', money.formatBase(forecast.perPerson, rates), 'all in')}
    ${stat('Already paid', money.formatBase(forecast.settled, rates), 'someone has fronted this')}
    ${stat('Still estimated', money.formatBase(forecast.estimated, rates), 'nobody has paid yet')}
    ${
      budget
        ? stat(
            'Vs budget',
            `${over > 0 ? '+' : ''}${money.formatBase(over, rates)}`,
            `target ${money.formatBase(budget, rates)}`,
            over > 0 ? 'gain' : 'loss'
          )
        : ''
    }
  `;
}

function stat(label, value, sub = '', modifier = '') {
  return `
    <div class="stat${modifier ? ` stat--${modifier}` : ''}">
      <span class="stat__label">${label}</span>
      <span class="stat__value">${value}</span>
      ${sub ? `<span class="stat__sub">${sub}</span>` : ''}
    </div>
  `;
}

function renderBalances(combined, people, rates) {
  const balances = money.balances(combined, people, rates);
  const paidSomething = combined.some((expense) => expense.paidBy);

  document.getElementById('balance-note').textContent = paidSomething
    ? 'Only money actually paid counts here'
    : 'Nothing paid yet';

  document.getElementById('balances').innerHTML = balances
    .map((entry) => {
      const sign = entry.net > 0.01 ? 'positive' : entry.net < -0.01 ? 'negative' : 'zero';
      const label =
        sign === 'positive'
          ? 'is owed'
          : sign === 'negative'
            ? 'owes the group'
            : 'square';
      return `
        <div class="balance" data-sign="${sign}">
          <div>
            <div class="balance__name">${escapeHtml(entry.name)}</div>
            <div class="balance__sub">
              paid ${money.formatBase(entry.paid, rates)} ·
              share ${money.formatBase(entry.owed, rates)}
            </div>
          </div>
          <div>
            <div class="balance__net">${money.formatBase(Math.abs(entry.net), rates)}</div>
            <div class="balance__sub" style="text-align:right">${label}</div>
          </div>
        </div>`;
    })
    .join('');

  const transfers = money.settleUp(balances);
  const container = document.getElementById('settle');

  if (!transfers.length) {
    container.innerHTML =
      '<p class="empty">Everyone is square. Nothing to transfer.</p>';
    return;
  }

  container.innerHTML = `
    ${transfers
      .map(
        (transfer) => `
          <div class="transfer">
            <strong>${escapeHtml(transfer.fromName)}</strong>
            <span class="faint">pays</span>
            <strong>${escapeHtml(transfer.toName)}</strong>
            <span class="transfer__amount">${money.formatBase(transfer.amount, rates)}</span>
          </div>`
      )
      .join('')}
    <p class="faint" style="margin:.3rem 0 0;font-size:.78rem">
      ${transfers.length} transfer${transfers.length === 1 ? '' : 's'} clears all
      ${money.formatBase(
        money.balances(combined, people, rates).reduce((sum, entry) => sum + Math.max(0, entry.net), 0),
        rates
      )} of outstanding balances.
    </p>
  `;
}

function renderCategories(combined, rates) {
  const rows = money.byCategory(combined, rates);
  const total = rows.reduce((sum, row) => sum + row.amount, 0) || 1;

  document.getElementById('categories').innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <div class="bar-row">
              <span>${escapeHtml(row.category)}</span>
              <span class="bar"><i style="width:${(row.amount / total) * 100}%"></i></span>
              <span class="numeric faint">${money.formatBase(row.amount, rates)}</span>
            </div>`
        )
        .join('')
    : '<p class="empty">No expenses yet.</p>';
}

function renderPeople(people, combined, rates) {
  const balances = money.balances(combined, people, rates);

  document.getElementById('people-list').innerHTML = `
    <div class="stack stack--tight" style="padding:.6rem">
      ${people.people
        .map((person) => {
          const balance = balances.find((entry) => entry.id === person.id);
          return `
            <div class="segment" style="border-left-color:${person.color || 'var(--c-accent)'}">
              <input type="text" value="${escapeHtml(person.name)}"
                data-rename="${person.id}" aria-label="Name" style="max-width:11rem" />
              <span class="segment__label faint numeric" style="font-size:.78rem">
                paid ${money.formatBase(balance?.paid || 0, rates)}
              </span>
              <label class="row row--tight" style="gap:.25rem">
                <span class="faint" style="font-size:.72rem">shares</span>
                <input type="number" min="0" step="1" value="${person.shares ?? 1}"
                  data-shares="${person.id}" style="width:3.6rem" />
              </label>
              <button class="btn btn--sm btn--danger" data-remove-person="${person.id}">×</button>
            </div>`;
        })
        .join('')}
    </div>`;

  document.querySelectorAll('[data-rename]').forEach((input) => {
    input.addEventListener('change', () => {
      store.update('people', (data) => {
        const person = data.people.find((entry) => entry.id === input.dataset.rename);
        if (person) person.name = input.value.trim() || person.name;
      });
    });
  });

  document.querySelectorAll('[data-shares]').forEach((input) => {
    input.addEventListener('change', () => {
      store.update('people', (data) => {
        const person = data.people.find((entry) => entry.id === input.dataset.shares);
        if (person) person.shares = Math.max(0, Number(input.value) || 0);
      });
    });
  });

  document.querySelectorAll('[data-remove-person]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.removePerson;
      const involved = store
        .get('expenses')
        .expenses.some(
          (expense) => expense.paidBy === id || expense.participants?.includes(id)
        );
      if (
        involved &&
        !window.confirm(
          'This person appears in existing expenses. Removing them will change the balances. Continue?'
        )
      ) {
        return;
      }
      store.update('people', (data) => {
        data.people = data.people.filter((entry) => entry.id !== id);
      });
    });
  });
}

function addPerson() {
  const name = window.prompt('Name?');
  if (!name) return;
  const palette = ['#2f6f4e', '#b5651d', '#3b6ea5', '#7d5ba6', '#9d2f2f', '#4a7c59'];
  store.update('people', (data) => {
    data.people.push({
      id: store.newId('p-'),
      name: name.trim(),
      shares: 1,
      color: palette[data.people.length % palette.length],
    });
  });
}

function renderRates(rates) {
  document.getElementById('rates-asof').textContent = `as of ${rates.asOf}`;

  document.getElementById('rates-list').innerHTML = rates.rates
    .map(
      (rate) => `
        <div class="bar-row" style="grid-template-columns:4rem 1fr auto">
          <span class="mono">${rate.currency}</span>
          <input type="number" step="0.0001" min="0" value="${rate.toBase}"
            data-rate="${rate.currency}" ${rate.currency === rates.base ? 'disabled' : ''} />
          <span class="faint" style="font-size:.75rem">= 1 ${rates.base}</span>
        </div>`
    )
    .join('');

  document.querySelectorAll('[data-rate]').forEach((input) => {
    input.addEventListener('change', () => {
      store.update('rates', (data) => {
        const rate = data.rates.find((entry) => entry.currency === input.dataset.rate);
        if (rate) rate.toBase = Number(input.value) || rate.toBase;
        data.asOf = new Date().toISOString().slice(0, 10);
      });
    });
  });
}

function renderExpenses(combined, people, rates) {
  const body = document.querySelector('#expense-table tbody');
  const nameOf = (id) => people.people.find((person) => person.id === id)?.name;

  const sorted = [...combined].sort((a, b) => {
    if (a.derived !== b.derived) return a.derived ? 1 : -1;
    return String(a.date || '').localeCompare(String(b.date || ''));
  });

  if (!sorted.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No expenses yet.</td></tr>';
    return;
  }

  body.innerHTML = sorted
    .map((expense) => {
      const base = money.toBase(expense.amount || 0, expense.currency, rates);
      const participants = expense.participants?.length
        ? `${expense.participants.length} of ${people.people.length}`
        : 'everyone';

      return `
        <tr>
          <td>${expense.date ? schedule.formatDate(expense.date) : '<span class="faint">—</span>'}</td>
          <td>
            ${escapeHtml(expense.description)}
            ${expense.derived ? '<span class="chip chip--info">from Stays</span>' : ''}
            ${expense.estimated ? '<span class="chip chip--warm">estimate</span>' : ''}
            ${expense.note ? `<br><small class="faint">${escapeHtml(expense.note)}</small>` : ''}
          </td>
          <td>${escapeHtml(expense.category || 'other')}</td>
          <td>${
            expense.paidBy
              ? escapeHtml(nameOf(expense.paidBy) || expense.paidBy)
              : '<span class="faint">nobody yet</span>'
          }</td>
          <td>${escapeHtml(expense.splitMode || 'equal')}<br><small class="faint">${participants}</small></td>
          <td class="num">${money.formatMoney(expense.amount, expense.currency, rates)}</td>
          <td class="num">${money.formatBase(base, rates)}</td>
          <td class="num">
            ${
              expense.derived
                ? '<a class="btn btn--sm" href="stays.html">Stays</a>'
                : `<button class="btn btn--sm" data-edit="${expense.id}">Edit</button>`
            }
          </td>
        </tr>`;
    })
    .join('');

  body.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => openDialog(button.dataset.edit));
  });
}

/* ------------------------------------------------------------------ */
/* expense dialog                                                      */
/* ------------------------------------------------------------------ */

function wireDialog() {
  document.getElementById('expense-save').addEventListener('click', () => {
    const value = readDialog();
    if (!value.description) {
      window.alert('A description is required.');
      return;
    }
    if (!value.amount) {
      window.alert('An amount is required.');
      return;
    }

    const problem = validateSplit(value);
    if (problem && !window.confirm(`${problem}\n\nSave anyway?`)) return;

    store.update('expenses', (data) => {
      if (state.editing) {
        const index = data.expenses.findIndex((entry) => entry.id === state.editing);
        if (index >= 0) data.expenses[index] = { ...data.expenses[index], ...value };
      } else {
        data.expenses.push({ id: store.newId('e-'), ...value });
      }
    });

    document.getElementById('expense-dialog').close();
    openChangesDialog('expenses');
  });

  document.getElementById('expense-delete').addEventListener('click', () => {
    if (!state.editing) return document.getElementById('expense-dialog').close();
    if (!window.confirm('Delete this expense?')) return;
    store.update('expenses', (data) => {
      data.expenses = data.expenses.filter((entry) => entry.id !== state.editing);
    });
    document.getElementById('expense-dialog').close();
  });

  document.getElementById('expense-split').addEventListener('change', renderParticipants);
  document.getElementById('expense-amount').addEventListener('input', updateSplitCheck);
}

function openDialog(id) {
  state.editing = id;
  const expense = id
    ? store.get('expenses').expenses.find((entry) => entry.id === id)
    : null;
  const rates = store.get('rates');
  const people = store.get('people');

  document.getElementById('expense-currency').innerHTML = rates.rates
    .map((rate) => `<option value="${rate.currency}">${rate.currency}</option>`)
    .join('');
  document.getElementById('expense-category').innerHTML = money.CATEGORIES.map(
    (category) => `<option value="${category}">${category}</option>`
  ).join('');
  document.getElementById('expense-paidby').innerHTML = people.people
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join('');

  document.getElementById('expense-title').textContent = expense ? 'Edit expense' : 'New expense';
  document.getElementById('expense-delete').hidden = !expense;

  const set = (elementId, value) => {
    document.getElementById(elementId).value = value ?? '';
  };
  set('expense-desc', expense?.description);
  set('expense-amount', expense?.amount);
  set('expense-currency', expense?.currency || 'EUR');
  set('expense-date', expense?.date || store.get('settings').trip.startDate);
  set('expense-category', expense?.category || 'food');
  set('expense-paidby', expense?.paidBy || people.people[0]?.id);
  set('expense-split', expense?.splitMode || 'equal');
  set('expense-note', expense?.note);

  state.draftExpense = expense;
  renderParticipants();
  document.getElementById('expense-dialog').showModal();
}

function renderParticipants() {
  const people = store.get('people');
  const expense = state.draftExpense;
  const mode = document.getElementById('expense-split').value;
  const selected = expense?.participants?.length
    ? new Set(expense.participants)
    : new Set(people.people.map((person) => person.id));

  const needsValue = mode !== 'equal';
  const unit = mode === 'percent' ? '%' : mode === 'shares' ? 'shares' : 'amount';

  document.getElementById('expense-participants').innerHTML = people.people
    .map((person) => {
      const value =
        expense?.splitValues?.[person.id] ??
        (mode === 'percent'
          ? Number((100 / people.people.length).toFixed(2))
          : mode === 'shares'
            ? person.shares ?? 1
            : '');
      return `
        <div class="row row--tight" style="justify-content:space-between">
          <label class="checkbox">
            <input type="checkbox" data-participant="${person.id}"
              ${selected.has(person.id) ? 'checked' : ''} />
            ${escapeHtml(person.name)}
          </label>
          ${
            needsValue
              ? `<label class="row row--tight" style="gap:.3rem">
                   <input type="number" step="0.01" min="0" value="${value}"
                     data-split-value="${person.id}" style="width:6rem" />
                   <span class="faint" style="font-size:.75rem">${unit}</span>
                 </label>`
              : ''
          }
        </div>`;
    })
    .join('');

  document
    .querySelectorAll('[data-split-value], [data-participant]')
    .forEach((input) => input.addEventListener('input', updateSplitCheck));

  updateSplitCheck();
}

function collectSplit() {
  const mode = document.getElementById('expense-split').value;
  const participants = [...document.querySelectorAll('[data-participant]')]
    .filter((input) => input.checked)
    .map((input) => input.dataset.participant);

  const splitValues = {};
  document.querySelectorAll('[data-split-value]').forEach((input) => {
    const id = input.dataset.splitValue;
    if (participants.includes(id)) splitValues[id] = Number(input.value) || 0;
  });

  return { mode, participants, splitValues };
}

/** Warn when exact or percentage splits do not add up to the total. */
function validateSplit({ amount, splitMode, participants, splitValues }) {
  if (!participants?.length) return 'Nobody is sharing this expense.';
  if (splitMode === 'exact') {
    const sum = Object.values(splitValues || {}).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - amount) > 0.01) {
      return `Exact amounts total ${sum.toFixed(2)} but the expense is ${amount.toFixed(2)}.`;
    }
  }
  if (splitMode === 'percent') {
    const sum = Object.values(splitValues || {}).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 100) > 0.01) return `Percentages total ${sum.toFixed(2)}%, not 100%.`;
  }
  if (splitMode === 'shares') {
    const sum = Object.values(splitValues || {}).reduce((total, value) => total + value, 0);
    if (sum <= 0) return 'Shares must add up to more than zero.';
  }
  return null;
}

function updateSplitCheck() {
  const amount = Number(document.getElementById('expense-amount').value) || 0;
  const { mode, participants, splitValues } = collectSplit();
  const problem = validateSplit({
    amount,
    splitMode: mode,
    participants,
    splitValues,
  });

  const element = document.getElementById('split-check');
  if (problem) {
    element.textContent = problem;
    element.style.color = 'var(--c-danger)';
  } else if (mode === 'equal' && participants.length) {
    element.textContent = `${(amount / participants.length).toFixed(2)} each across ${
      participants.length
    } ${participants.length === 1 ? 'person' : 'people'}.`;
    element.style.color = '';
  } else {
    element.textContent = 'Split adds up.';
    element.style.color = '';
  }
}

function readDialog() {
  const value = (id) => document.getElementById(id).value.trim();
  const { mode, participants, splitValues } = collectSplit();
  const everyone = store.get('people').people.length;

  return {
    description: value('expense-desc'),
    amount: Number(value('expense-amount')) || 0,
    currency: value('expense-currency'),
    date: value('expense-date') || null,
    category: value('expense-category'),
    paidBy: value('expense-paidby'),
    splitMode: mode,
    // Storing null for "everyone" keeps the file stable when people are added.
    participants: participants.length === everyone ? null : participants,
    splitValues: mode === 'equal' ? undefined : splitValues,
    note: value('expense-note'),
  };
}

main().catch(showLoadError);
