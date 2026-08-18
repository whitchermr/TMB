/**
 * Expense splitting, balances, and settle-up.
 *
 * Everything is converted to the base currency at the fixed rates in
 * data/rates.json before any arithmetic, so a three-country trip settles in one
 * number per person. Rates are pinned rather than live so the same inputs always
 * produce the same answer.
 */

/* ------------------------------------------------------------------ */
/* currency                                                            */
/* ------------------------------------------------------------------ */

export function rateTable(rates) {
  const table = new Map();
  rates.rates.forEach((entry) => table.set(entry.currency, entry));
  return table;
}

export function toBase(amount, currency, rates) {
  const entry = rateTable(rates).get(currency);
  if (!entry) return amount;
  return amount * entry.toBase;
}

export function formatMoney(amount, currency, rates) {
  if (amount == null || !Number.isFinite(amount)) return '—';
  const entry = rateTable(rates).get(currency);
  const symbol = entry?.symbol ?? '';
  const sign = amount < 0 ? '−' : '';
  const value = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // CHF reads better before the number without a space-free join.
  return symbol.length > 1 ? `${sign}${symbol} ${value}` : `${sign}${symbol}${value}`;
}

export function formatBase(amount, rates) {
  return formatMoney(amount, rates.base, rates);
}

/* ------------------------------------------------------------------ */
/* derived lodging expenses                                            */
/* ------------------------------------------------------------------ */

/**
 * Turn booked (or, as an estimate, cheapest candidate) lodging into expenses.
 *
 * Hotels are never entered twice: the Stays page owns them, and this projects
 * them into the ledger. Derived entries are flagged so the UI can show them as
 * read-only and point back to the stay.
 */
export function derivedStayExpenses(stays, people, itinerary) {
  const nightsByStop = new Map();
  itinerary.days.forEach((day) => {
    if (!day.stayAt) return;
    nightsByStop.set(day.stayAt, (nightsByStop.get(day.stayAt) || 0) + 1);
  });

  const everyone = people.people.map((person) => person.id);
  const expenses = [];

  stays.stops.forEach((stop) => {
    if (stop.includeInBudget === false) return;

    const booked = stop.options.find((option) => option.id === stop.bookedOptionId);
    const candidates = stop.options.filter((option) => option.status !== 'rejected');
    const option =
      booked ||
      candidates.reduce(
        (cheapest, current) =>
          !cheapest || current.pricePerPerson < cheapest.pricePerPerson ? current : cheapest,
        null
      );
    if (!option) return;

    const nights = stop.nights || nightsByStop.get(stop.stopId) || 1;
    const perPerson = (option.pricePerPerson || 0) * nights;

    expenses.push({
      id: `stay:${stop.stopId}:${option.id}`,
      derived: true,
      estimated: !booked,
      stopId: stop.stopId,
      date: null,
      description: `${stop.label} — ${option.name}${nights > 1 ? ` (${nights} nights)` : ''}`,
      category: 'lodging',
      amount: perPerson * everyone.length,
      currency: option.currency,
      // Nobody has fronted an estimate, so there is no payer until it's booked
      // and someone records the actual payment.
      paidBy: option.paidBy || null,
      splitMode: 'equal',
      participants: null,
      halfBoard: option.halfBoard === true,
    });
  });

  return expenses;
}

/* ------------------------------------------------------------------ */
/* splitting                                                           */
/* ------------------------------------------------------------------ */

/**
 * How much each participant owes for one expense, in base currency.
 * Returns a Map of person id to amount.
 */
export function shareOf(expense, people, rates) {
  const byId = new Map(people.people.map((person) => [person.id, person]));
  const participants = (expense.participants && expense.participants.length
    ? expense.participants
    : people.people.map((person) => person.id)
  ).filter((id) => byId.has(id));

  const total = toBase(expense.amount || 0, expense.currency, rates);
  const shares = new Map();
  if (!participants.length || !total) return shares;

  const values = expense.splitValues || {};

  if (expense.splitMode === 'exact') {
    participants.forEach((id) => {
      shares.set(id, toBase(Number(values[id]) || 0, expense.currency, rates));
    });
    return shares;
  }

  if (expense.splitMode === 'percent') {
    participants.forEach((id) => {
      shares.set(id, (total * (Number(values[id]) || 0)) / 100);
    });
    return shares;
  }

  const weights = participants.map((id) => {
    if (expense.splitMode === 'shares') return Number(values[id]) || 0;
    return Number(byId.get(id).shares) || 1;
  });
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  if (!weightTotal) return shares;

  participants.forEach((id, index) => {
    shares.set(id, (total * weights[index]) / weightTotal);
  });
  return shares;
}

/**
 * Net position per person: positive means the group owes them, negative means
 * they owe the group.
 *
 * Only expenses that somebody has actually paid can create a debt. Lodging
 * estimates carry no payer until they are booked and paid, so including them
 * here would invent money owed to nobody and the balances would not sum to
 * zero. Use `forecast()` for the budget view that does count estimates.
 */
export function balances(expenses, people, rates) {
  const net = new Map(people.people.map((person) => [person.id, 0]));
  const paid = new Map(people.people.map((person) => [person.id, 0]));
  const owed = new Map(people.people.map((person) => [person.id, 0]));

  expenses.forEach((expense) => {
    if (!expense.paidBy || !net.has(expense.paidBy)) return;
    const total = toBase(expense.amount || 0, expense.currency, rates);
    net.set(expense.paidBy, net.get(expense.paidBy) + total);
    paid.set(expense.paidBy, paid.get(expense.paidBy) + total);

    shareOf(expense, people, rates).forEach((amount, id) => {
      if (!net.has(id)) return;
      net.set(id, net.get(id) - amount);
      owed.set(id, owed.get(id) + amount);
    });
  });

  return people.people.map((person) => ({
    id: person.id,
    name: person.name,
    color: person.color,
    paid: paid.get(person.id) || 0,
    owed: owed.get(person.id) || 0,
    net: net.get(person.id) || 0,
  }));
}

/**
 * Minimal set of transfers that clears every balance.
 *
 * Repeatedly matches the largest creditor against the largest debtor, which is
 * the same greedy approach Splitwise uses. It is not provably optimal in the
 * general case (that problem is NP-hard) but for a group this size it produces
 * at most one transfer fewer than the number of people, which is the practical
 * goal.
 */
export function settleUp(balanceList, epsilon = 0.01) {
  const creditors = balanceList
    .filter((entry) => entry.net > epsilon)
    .map((entry) => ({ ...entry, remaining: entry.net }))
    .sort((a, b) => b.remaining - a.remaining);
  const debtors = balanceList
    .filter((entry) => entry.net < -epsilon)
    .map((entry) => ({ ...entry, remaining: -entry.net }))
    .sort((a, b) => b.remaining - a.remaining);

  const transfers = [];
  let guard = 0;

  while (creditors.length && debtors.length && guard < 1000) {
    guard += 1;
    creditors.sort((a, b) => b.remaining - a.remaining);
    debtors.sort((a, b) => b.remaining - a.remaining);

    const creditor = creditors[0];
    const debtor = debtors[0];
    const amount = Math.min(creditor.remaining, debtor.remaining);

    transfers.push({
      fromId: debtor.id,
      fromName: debtor.name,
      toId: creditor.id,
      toName: creditor.name,
      amount,
    });

    creditor.remaining -= amount;
    debtor.remaining -= amount;
    if (creditor.remaining <= epsilon) creditors.shift();
    if (debtor.remaining <= epsilon) debtors.shift();
  }

  return transfers;
}

/** Per-category rollup for the summary chart. */
export function byCategory(expenses, rates) {
  const totals = new Map();
  expenses.forEach((expense) => {
    const key = expense.category || 'other';
    const amount = toBase(expense.amount || 0, expense.currency, rates);
    totals.set(key, (totals.get(key) || 0) + amount);
  });
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export const CATEGORIES = [
  'lodging',
  'food',
  'transport',
  'luggage',
  'gear',
  'fees',
  'other',
];

export function tripTotal(expenses, rates) {
  return expenses.reduce(
    (sum, expense) => sum + toBase(expense.amount || 0, expense.currency, rates),
    0
  );
}

/**
 * Budget view: what the trip is expected to cost per person, separating money
 * already spent from lodging that is still only an estimate.
 *
 * This is the counterpart to `balances()` — it deliberately counts unpaid
 * estimates, because the question it answers is "what should we each expect to
 * pay" rather than "who owes whom right now".
 */
export function forecast(expenses, people, rates) {
  const headcount = people.people.length || 1;
  let settled = 0;
  let estimated = 0;

  expenses.forEach((expense) => {
    const amount = toBase(expense.amount || 0, expense.currency, rates);
    if (expense.paidBy) settled += amount;
    else estimated += amount;
  });

  const total = settled + estimated;
  return {
    total,
    settled,
    estimated,
    perPerson: total / headcount,
    perPersonSettled: settled / headcount,
    perPersonEstimated: estimated / headcount,
    headcount,
  };
}
