/**
 * Elevation profile chart on a canvas.
 *
 * Written rather than pulled from a library so that three things specific to
 * this trip work properly: waypoint ticks positioned by real distance along the
 * day, an optional second series so a shortcut and the classic stage can be
 * compared on one axis, and a cursor that drives the map marker both ways.
 *
 * Interaction is pointer-based, so mouse, trackpad, pen and touch all work with
 * the same code path and no hover-only behaviour.
 */

import * as units from '../core/units.js';

const PADDING = { top: 16, right: 12, bottom: 26, left: 46 };

export function createElevationChart(container, options = {}) {
  container.classList.add('elev');
  container.style.height = options.height || '210px';

  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  container.append(canvas);

  const readout = document.createElement('div');
  readout.className = 'elev__readout';
  container.append(readout);

  const context = canvas.getContext('2d');

  let series = [];
  let waypoints = [];
  let cursorPosition = null;
  let scale = null;
  const handlers = { hover: options.onHover, leave: options.onLeave, select: options.onSelect };

  /* ---------------------------------------------------------------- */
  /* sizing                                                           */
  /* ---------------------------------------------------------------- */

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const width = container.clientWidth;
    const height = container.clientHeight;
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);

  /* ---------------------------------------------------------------- */
  /* scales                                                           */
  /* ---------------------------------------------------------------- */

  function computeScale() {
    const width = container.clientWidth;
    const height = container.clientHeight;
    const plotWidth = Math.max(1, width - PADDING.left - PADDING.right);
    const plotHeight = Math.max(1, height - PADDING.top - PADDING.bottom);

    let maxDistance = 0;
    let minElevation = Infinity;
    let maxElevation = -Infinity;

    series.forEach((entry) => {
      const cum = entry.cumulative_m;
      if (!cum?.length) return;
      maxDistance = Math.max(maxDistance, cum[cum.length - 1]);
      entry.elevation_m.forEach((value) => {
        if (value == null) return;
        if (value < minElevation) minElevation = value;
        if (value > maxElevation) maxElevation = value;
      });
    });

    if (!Number.isFinite(minElevation)) {
      minElevation = 0;
      maxElevation = 100;
    }

    // Pad the vertical range so the trace never touches the frame, and keep a
    // sane floor so a flat valley day still reads as a profile.
    const span = Math.max(120, maxElevation - minElevation);
    const pad = span * 0.12;
    const low = Math.max(0, minElevation - pad);
    const high = maxElevation + pad;

    return {
      width,
      height,
      plotWidth,
      plotHeight,
      maxDistance: maxDistance || 1,
      low,
      high,
      x: (metres) => PADDING.left + (metres / (maxDistance || 1)) * plotWidth,
      y: (metres) =>
        PADDING.top + plotHeight - ((metres - low) / (high - low || 1)) * plotHeight,
      toDistance: (px) =>
        Math.max(0, Math.min(maxDistance, ((px - PADDING.left) / plotWidth) * maxDistance)),
    };
  }

  /* ---------------------------------------------------------------- */
  /* drawing                                                          */
  /* ---------------------------------------------------------------- */

  function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function niceStep(range, target) {
    const raw = range / target;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalised = raw / magnitude;
    const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function draw() {
    scale = computeScale();
    const { width, height, plotWidth, plotHeight } = scale;

    context.clearRect(0, 0, width, height);
    if (!series.length) {
      context.fillStyle = cssVar('--c-text-faint', '#888');
      context.font = '13px system-ui, sans-serif';
      context.textAlign = 'center';
      context.fillText('No elevation data', width / 2, height / 2);
      return;
    }

    const border = cssVar('--c-border', '#ddd');
    const faint = cssVar('--c-text-faint', '#888');
    const text = cssVar('--c-text-soft', '#555');

    /* horizontal gridlines and elevation labels */
    const elevationRange = scale.high - scale.low;
    const displayFactor = units.isImperial() ? 3.28084 : 1;
    const step = niceStep(elevationRange * displayFactor, 4) / displayFactor;

    context.font = '10px system-ui, sans-serif';
    context.textAlign = 'right';
    context.textBaseline = 'middle';
    context.lineWidth = 1;

    for (let value = Math.ceil(scale.low / step) * step; value <= scale.high; value += step) {
      const y = Math.round(scale.y(value)) + 0.5;
      context.strokeStyle = border;
      context.beginPath();
      context.moveTo(PADDING.left, y);
      context.lineTo(PADDING.left + plotWidth, y);
      context.stroke();

      context.fillStyle = faint;
      context.fillText(
        Math.round(value * displayFactor).toLocaleString(),
        PADDING.left - 6,
        y
      );
    }

    /* distance axis */
    const distanceDisplayMax = units.toDisplayDistance(scale.maxDistance);
    const distanceStep = niceStep(distanceDisplayMax, 5);
    context.textAlign = 'center';
    context.textBaseline = 'top';

    for (let value = 0; value <= distanceDisplayMax + 1e-9; value += distanceStep) {
      const metres = units.isImperial() ? value * 1609.344 : value * 1000;
      if (metres > scale.maxDistance) break;
      const x = Math.round(scale.x(metres)) + 0.5;
      context.strokeStyle = border;
      context.beginPath();
      context.moveTo(x, PADDING.top);
      context.lineTo(x, PADDING.top + plotHeight);
      context.stroke();
      context.fillStyle = faint;
      context.fillText(
        `${Number(value.toFixed(distanceStep < 1 ? 1 : 0))}`,
        x,
        PADDING.top + plotHeight + 6
      );
    }

    context.fillStyle = text;
    context.textAlign = 'right';
    context.fillText(units.distanceUnit(), PADDING.left + plotWidth, PADDING.top + plotHeight + 6);
    context.textAlign = 'left';
    context.fillText(units.elevationUnit(), 4, PADDING.top - 12);

    /* series, comparison layers underneath the primary one */
    [...series].reverse().forEach((entry) => {
      drawSeries(entry, entry === series[0]);
    });

    drawWaypoints();
    drawCursor();
  }

  function drawSeries(entry, isPrimary) {
    const cum = entry.cumulative_m;
    const elevations = entry.elevation_m;
    if (!cum?.length) return;

    const color = entry.color || cssVar('--c-accent', '#2f6f4e');

    context.beginPath();
    let started = false;
    for (let i = 0; i < cum.length; i += 1) {
      const value = elevations[i];
      if (value == null) continue;
      const x = scale.x(cum[i]);
      const y = scale.y(value);
      if (started) context.lineTo(x, y);
      else {
        context.moveTo(x, y);
        started = true;
      }
    }
    if (!started) return;

    if (isPrimary) {
      // Fill under the primary trace only, so a comparison overlay stays legible.
      const area = new Path2D();
      let last = null;
      area.moveTo(scale.x(cum[0]), PADDING.top + scale.plotHeight);
      for (let i = 0; i < cum.length; i += 1) {
        const value = elevations[i];
        if (value == null) continue;
        last = cum[i];
        area.lineTo(scale.x(cum[i]), scale.y(value));
      }
      if (last !== null) {
        area.lineTo(scale.x(last), PADDING.top + scale.plotHeight);
        area.closePath();
        const gradient = context.createLinearGradient(
          0,
          PADDING.top,
          0,
          PADDING.top + scale.plotHeight
        );
        gradient.addColorStop(0, hexToRgba(color, 0.32));
        gradient.addColorStop(1, hexToRgba(color, 0.03));
        context.fillStyle = gradient;
        context.fill(area);
      }
    }

    context.strokeStyle = color;
    context.lineWidth = isPrimary ? 2 : 1.5;
    context.setLineDash(entry.dashed ? [5, 4] : []);
    context.lineJoin = 'round';
    context.stroke();
    context.setLineDash([]);
  }

  function drawWaypoints() {
    if (!waypoints.length) return;
    const warm = cssVar('--c-warm', '#b5651d');
    const optional = cssVar('--c-optional', '#7d5ba6');
    const top = PADDING.top;
    const bottom = PADDING.top + scale.plotHeight;

    waypoints.forEach((waypoint) => {
      if (waypoint.position_m == null) return;
      const x = Math.round(scale.x(waypoint.position_m)) + 0.5;
      const color = waypoint.isDetour ? optional : warm;

      context.strokeStyle = hexToRgba(color, waypoint.priority === 1 ? 0.75 : 0.4);
      context.lineWidth = 1;
      context.setLineDash(waypoint.priority === 1 ? [] : [3, 3]);
      context.beginPath();
      context.moveTo(x, top);
      context.lineTo(x, bottom);
      context.stroke();
      context.setLineDash([]);

      if (waypoint.priority === 1) {
        context.fillStyle = color;
        context.beginPath();
        context.arc(x, top + 3, 3, 0, Math.PI * 2);
        context.fill();
      }
    });
  }

  function drawCursor() {
    if (cursorPosition == null) return;
    const x = Math.round(scale.x(cursorPosition)) + 0.5;
    context.strokeStyle = cssVar('--c-danger', '#9d2f2f');
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(x, PADDING.top);
    context.lineTo(x, PADDING.top + scale.plotHeight);
    context.stroke();

    const primary = series[0];
    const value = sampleAt(primary, cursorPosition);
    if (value != null) {
      context.fillStyle = cssVar('--c-danger', '#9d2f2f');
      context.beginPath();
      context.arc(x, scale.y(value), 4, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = cssVar('--c-surface', '#fff');
      context.lineWidth = 1.5;
      context.stroke();
    }
  }

  function sampleAt(entry, positionM) {
    if (!entry?.cumulative_m?.length) return null;
    const cum = entry.cumulative_m;
    const values = entry.elevation_m;
    let lo = 0;
    let hi = cum.length - 1;
    if (positionM <= cum[0]) return values[0];
    if (positionM >= cum[hi]) return values[hi];
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= positionM) lo = mid;
      else hi = mid;
    }
    const a = values[lo];
    const b = values[hi];
    if (a == null) return b;
    if (b == null) return a;
    const span = cum[hi] - cum[lo];
    const t = span ? (positionM - cum[lo]) / span : 0;
    return a + (b - a) * t;
  }

  /* ---------------------------------------------------------------- */
  /* interaction                                                      */
  /* ---------------------------------------------------------------- */

  function positionFromEvent(event) {
    const rect = canvas.getBoundingClientRect();
    return scale.toDistance(event.clientX - rect.left);
  }

  function updateReadout(positionM) {
    const primary = series[0];
    const elevationValue = sampleAt(primary, positionM);
    if (elevationValue == null) {
      readout.dataset.active = 'false';
      return;
    }
    const parts = [
      `<b>${units.distance(positionM)}</b>`,
      `<b>${units.elevation(elevationValue)}</b>`,
    ];
    if (series.length > 1) {
      const other = sampleAt(series[1], positionM);
      if (other != null) {
        parts.push(
          `<span style="color:${series[1].color}">${units.elevation(other)}</span>`
        );
      }
    }
    if (primary.timeAt) {
      const hours = primary.timeAt(positionM);
      if (hours != null) parts.push(`<span>${units.duration(hours)}</span>`);
    }
    readout.innerHTML = parts.join('');
    readout.dataset.active = 'true';
  }

  function handleMove(event) {
    if (!scale) return;
    const positionM = positionFromEvent(event);
    cursorPosition = positionM;
    updateReadout(positionM);
    draw();
    handlers.hover?.(positionM, sampleAt(series[0], positionM));
  }

  function handleLeave() {
    cursorPosition = null;
    readout.dataset.active = 'false';
    draw();
    handlers.leave?.();
  }

  canvas.addEventListener('pointermove', (event) => {
    // For touch, only track while the finger is down so vertical scrolling works.
    if (event.pointerType === 'touch' && event.buttons === 0) return;
    handleMove(event);
  });

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture?.(event.pointerId);
    handleMove(event);
  });

  canvas.addEventListener('pointerup', (event) => {
    handlers.select?.(positionFromEvent(event));
  });

  canvas.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'touch') return;
    handleLeave();
  });

  canvas.addEventListener('pointercancel', handleLeave);

  /* ---------------------------------------------------------------- */
  /* public API                                                       */
  /* ---------------------------------------------------------------- */

  return {
    /**
     * @param {Array} nextSeries first entry is primary; later entries render as
     *   comparison lines. Each needs { cumulative_m, elevation_m, color, dashed,
     *   label, timeAt? }.
     */
    setSeries(nextSeries) {
      series = (nextSeries || []).filter((entry) => entry?.cumulative_m?.length);
      canvas.setAttribute(
        'aria-label',
        series.length
          ? `Elevation profile: ${series
              .map((entry) => entry.label || 'route')
              .join(' compared with ')}`
          : 'Elevation profile, no data'
      );
      draw();
    },
    setWaypoints(nextWaypoints) {
      waypoints = nextWaypoints || [];
      draw();
    },
    /** Move the cursor from outside, e.g. when a waypoint is clicked. */
    setCursor(positionM, { showReadout = true } = {}) {
      cursorPosition = positionM;
      if (positionM == null) readout.dataset.active = 'false';
      else if (showReadout) updateReadout(positionM);
      draw();
    },
    elevationAt(positionM) {
      return sampleAt(series[0], positionM);
    },
    redraw: draw,
    destroy() {
      observer.disconnect();
      container.innerHTML = '';
    },
  };
}

function hexToRgba(hex, alpha) {
  const value = String(hex).trim();
  if (!value.startsWith('#')) return value;
  let raw = value.slice(1);
  if (raw.length === 3) raw = raw.split('').map((c) => c + c).join('');
  const int = parseInt(raw, 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
