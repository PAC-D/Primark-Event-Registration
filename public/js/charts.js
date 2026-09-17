// Admin dashboard charts (Chart.js 4, loaded as window.Chart). The numbers come from /shared/chart-data.js.
import { prefersReducedMotion } from './motion.js';
import { COVERAGE_ORDER, coverageBreakdown, registrationTimeline } from '/shared/chart-data.js';
import { escapeHtml } from '/shared/form-logic.js';

// Validated with the dataviz palette checks against the card surface #f7fbff:
// the line colour passes the categorical gates; the coverage ramp passes the ordinal gates.
const COLORS = {
  line: '#0a78bd',
  lineFill: 'rgba(10, 120, 189, 0.12)',
  coverage: { missing: '#5fb4df', registered: '#0a78bd', full: '#0b3f7a' },
  surface: '#f7fbff',
  ink: '#16264a',
  muted: '#6b7a96',
  grid: 'rgba(0, 43, 97, 0.08)',
  crosshair: 'rgba(0, 43, 97, 0.25)',
};
const STATUS_LABEL = { missing: 'Missing', registered: 'Registered', full: 'Full' };
const PLURAL = { supplier: 'suppliers', factory: 'factories' };

const charts = {};
let timelinePoints = [];
let coverageHandler = () => {};

const shortDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const longDay = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const tooltipStyle = {
  backgroundColor: '#ffffff',
  titleColor: COLORS.ink,
  bodyColor: COLORS.ink,
  borderColor: 'rgba(0, 43, 97, 0.12)',
  borderWidth: 1,
  padding: 12,
  cornerRadius: 12,
  titleFont: { weight: '800' },
  bodyFont: { weight: '600' },
  displayColors: false,
};

// Vertical guide line under the hovered day on the timeline.
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements() ?? [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    ctx.strokeStyle = COLORS.crosshair;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function renderTimeline(participants) {
  timelinePoints = registrationTimeline(participants);
  const canvas = document.getElementById('chart-timeline');
  const hasData = timelinePoints.length > 0;
  canvas.parentElement.hidden = !hasData;
  document.getElementById('timeline-empty').hidden = hasData;

  const labels = timelinePoints.map((p) => shortDay(p.day));
  const totals = timelinePoints.map((p) => p.total);
  const pointRadius = timelinePoints.length === 1 ? 5 : 0;

  if (charts.timeline) {
    charts.timeline.data.labels = labels;
    charts.timeline.data.datasets[0].data = totals;
    charts.timeline.data.datasets[0].pointRadius = pointRadius;
    charts.timeline.update();
    return;
  }

  charts.timeline = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Participants',
        data: totals,
        borderColor: COLORS.line,
        backgroundColor: COLORS.lineFill,
        fill: true,
        borderWidth: 2,
        tension: 0.35,
        pointRadius,
        pointHoverRadius: 6,
        pointBackgroundColor: COLORS.line,
        pointBorderColor: COLORS.surface,
        pointBorderWidth: 2,
      }],
    },
    options: {
      maintainAspectRatio: false,
      animation: prefersReducedMotion() ? false : { duration: 900, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          callbacks: {
            title: (items) => longDay(timelinePoints[items[0].dataIndex].day),
            label: (item) => {
              const point = timelinePoints[item.dataIndex];
              return [`${point.total} participants in total`, `${point.count} registered that day`];
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: 'rgba(0, 43, 97, 0.15)' }, ticks: { maxRotation: 0, autoSkipPadding: 16 } },
        y: { beginAtZero: true, grid: { color: COLORS.grid }, border: { display: false }, ticks: { precision: 0 } },
      },
    },
    plugins: [crosshair],
  });
}

function renderCoverage(kind, organisations) {
  const counts = coverageBreakdown(organisations, kind);
  const values = COVERAGE_ORDER.map((status) => counts[status]);
  const registered = counts.total - counts.missing;

  document.getElementById(`center-${kind}`).innerHTML =
    `<strong>${registered}/${counts.total}</strong><span>registered</span>`;

  const legend = document.getElementById(`legend-${kind}`);
  const chart = charts[kind];
  legend.innerHTML = COVERAGE_ORDER.map((status, index) => {
    const visible = chart ? chart.getDataVisibility(index) : true;
    const label = STATUS_LABEL[status];
    return `<li>
      <button type="button" class="legend-item" data-legend-index="${index}" aria-pressed="${visible}"
        aria-label="${escapeHtml(`${label}: ${counts[status]} ${PLURAL[kind]}. Toggle slice`)}">
        <span class="swatch" style="background:${COLORS.coverage[status]}"></span>
        <span class="legend-label">${label}</span>
        <strong>${counts[status]}</strong>
      </button>
      <button type="button" class="link-btn legend-view" data-view-status="${status}"
        aria-label="${escapeHtml(`View ${label.toLowerCase()} ${PLURAL[kind]}`)}">View</button>
    </li>`;
  }).join('');

  if (chart) {
    chart.data.datasets[0].data = values;
    chart.update();
    return;
  }

  const canvas = document.getElementById(`chart-${kind}`);
  charts[kind] = new window.Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: COVERAGE_ORDER.map((status) => STATUS_LABEL[status]),
      datasets: [{
        data: values,
        backgroundColor: COVERAGE_ORDER.map((status) => COLORS.coverage[status]),
        borderColor: COLORS.surface,
        borderWidth: 2,
        borderRadius: 4,
        hoverOffset: 10,
      }],
    },
    options: {
      maintainAspectRatio: false,
      cutout: '68%',
      layout: { padding: 8 },
      animation: prefersReducedMotion() ? false : { animateRotate: true, animateScale: true, duration: 900, easing: 'easeOutQuart' },
      plugins: {
        legend: { display: false },
        tooltip: {
          ...tooltipStyle,
          callbacks: {
            label: (item) => {
              const total = item.dataset.data.reduce((sum, n) => sum + n, 0);
              const share = total ? Math.round((item.raw / total) * 100) : 0;
              return `${item.label}: ${item.raw} ${PLURAL[kind]} (${share}%)`;
            },
          },
        },
      },
    },
  });

  // Slice click → the Suppliers/Factories tab filtered to that status.
  canvas.addEventListener('click', (event) => {
    const [hit] = charts[kind].getElementsAtEventForMode(event, 'nearest', { intersect: true }, true);
    if (hit) coverageHandler(kind, COVERAGE_ORDER[hit.index]);
  });
  canvas.addEventListener('mousemove', (event) => {
    const hits = charts[kind].getElementsAtEventForMode(event, 'nearest', { intersect: true }, false);
    canvas.style.cursor = hits.length ? 'pointer' : 'default';
  });

  legend.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-legend-index]');
    if (toggle) {
      const index = Number(toggle.dataset.legendIndex);
      charts[kind].toggleDataVisibility(index);
      charts[kind].update();
      toggle.setAttribute('aria-pressed', String(charts[kind].getDataVisibility(index)));
      return;
    }
    const view = event.target.closest('[data-view-status]');
    if (view) coverageHandler(kind, view.dataset.viewStatus);
  });
}

// data: DashboardData from /api/admin/data. onCoverageClick(kind, status) opens the matching filtered tab.
export function renderCharts(data, { onCoverageClick }) {
  const section = document.getElementById('charts');
  if (!window.Chart) {
    // Chart.js failed to load (e.g. CDN blocked): the rest of the dashboard still works.
    section.hidden = true;
    return;
  }
  coverageHandler = onCoverageClick;
  window.Chart.defaults.font.family = '"Nunito", system-ui, sans-serif';
  window.Chart.defaults.color = COLORS.muted;
  renderTimeline(data.participants);
  renderCoverage('supplier', data.organisations);
  renderCoverage('factory', data.organisations);
}
