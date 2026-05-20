export function renderAdminDashboardPage(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Bio Swarm Admin Dashboard</title>
		<style>
			:root {
				--bg-0: #061423;
				--bg-1: #0f2a42;
				--bg-2: #153a5b;
				--card: #f6fbff;
				--ink: #0c1d2e;
				--muted: #4a6076;
				--warn: #d9480f;
				--ok: #2f9e44;
				--line: #d4e4f2;
				--accent: #0ea5e9;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				min-height: 100vh;
				font-family: "Avenir Next", "Segoe UI", sans-serif;
				background: radial-gradient(circle at 20% 15%, #1f4b73 0%, transparent 35%),
					radial-gradient(circle at 85% 80%, #1a6f8f 0%, transparent 30%),
					linear-gradient(140deg, var(--bg-0), var(--bg-1) 60%, var(--bg-2));
				color: #eaf5ff;
			}

			.wrap {
				max-width: 1180px;
				margin: 0 auto;
				padding: 24px 16px 48px;
			}

			.hero {
				display: flex;
				flex-wrap: wrap;
				gap: 14px;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 18px;
			}

			.title {
				margin: 0;
				font-size: clamp(1.5rem, 4vw, 2.4rem);
				letter-spacing: 0.03em;
			}

			.subtitle {
				margin: 4px 0 0;
				color: #c6def3;
			}

			.controls {
				display: flex;
				gap: 8px;
				flex-wrap: wrap;
			}

			.input,
			.button {
				border-radius: 12px;
				border: 1px solid rgba(255, 255, 255, 0.25);
				padding: 10px 12px;
				font: inherit;
			}

			.input {
				background: rgba(8, 22, 35, 0.45);
				color: #fff;
				min-width: 260px;
			}

			.button {
				background: linear-gradient(90deg, #22c55e, #0ea5e9);
				color: #062019;
				font-weight: 700;
				cursor: pointer;
			}

			.button.secondary {
				background: linear-gradient(90deg, #f59e0b, #0ea5e9);
				color: #132032;
			}

			.toggle {
				display: inline-flex;
				align-items: center;
				gap: 8px;
				padding: 10px 12px;
				border-radius: 12px;
				border: 1px solid rgba(255, 255, 255, 0.25);
				background: rgba(8, 22, 35, 0.45);
				color: #eaf5ff;
				font-size: 0.9rem;
			}

			.grid {
				display: grid;
				grid-template-columns: repeat(12, minmax(0, 1fr));
				gap: 12px;
			}

			.card {
				background: var(--card);
				color: var(--ink);
				border-radius: 16px;
				border: 1px solid var(--line);
				padding: 14px;
			}

			.kpi {
				grid-column: span 6;
			}

			.wide {
				grid-column: span 12;
			}

			.half {
				grid-column: span 6;
			}

			h2,
			h3 {
				margin: 0 0 8px;
			}

			.row {
				display: flex;
				justify-content: space-between;
				gap: 8px;
				padding: 6px 0;
				border-bottom: 1px solid #e7f0f8;
			}

			.row:last-child {
				border-bottom: 0;
			}

			.badge {
				border-radius: 999px;
				padding: 4px 8px;
				font-size: 0.8rem;
				font-weight: 700;
			}

			.badge.warn {
				background: #ffe8cc;
				color: var(--warn);
			}

			.badge.ok {
				background: #d3f9d8;
				color: var(--ok);
			}

			.mono {
				font-family: ui-monospace, Menlo, monospace;
				font-size: 0.82rem;
				color: var(--muted);
			}

			.form-grid {
				display: grid;
				grid-template-columns: repeat(3, minmax(0, 1fr));
				gap: 8px;
			}

			.form-grid .input {
				min-width: 0;
				background: #fff;
				color: var(--ink);
				border-color: var(--line);
			}

			.form-row {
				display: flex;
				gap: 8px;
				margin-top: 8px;
				flex-wrap: wrap;
			}

			.textarea {
				width: 100%;
				min-height: 88px;
				border-radius: 12px;
				border: 1px solid var(--line);
				padding: 10px 12px;
				font: inherit;
				resize: vertical;
			}

			.mini-btn {
				border: 1px solid var(--line);
				background: #fff;
				border-radius: 10px;
				padding: 6px 10px;
				cursor: pointer;
				font-weight: 600;
			}

			.trend-wrap {
				display: flex;
				flex-direction: column;
				gap: 8px;
			}

			.trend-svg {
				width: 100%;
				height: 180px;
				border-radius: 12px;
				border: 1px solid var(--line);
				background: linear-gradient(180deg, #ffffff, #f5fbff);
			}

			.compare-grid {
				display: grid;
				grid-template-columns: 1fr 1fr;
				gap: 8px;
			}

			.status {
				margin: 8px 0 12px;
				min-height: 20px;
				color: #d9ecff;
			}

			@media (max-width: 900px) {
				.kpi,
				.half,
				.wide {
					grid-column: span 12;
				}

				.form-grid {
					grid-template-columns: 1fr;
				}

				.compare-grid {
					grid-template-columns: 1fr;
				}
			}
		</style>
	</head>
	<body>
		<main class="wrap">
			<section class="hero">
				<div>
					<h1 class="title">Bio Swarm Operator Console</h1>
					<p class="subtitle">Live attention view from /admin/dashboard</p>
				</div>
				<div class="controls">
					<input id="key" class="input" type="password" placeholder="Admin API key" />
					<label class="toggle"><input id="autoRefresh" type="checkbox" checked /> Auto 5s</label>
					<button id="refresh" class="button" type="button">Refresh</button>
				</div>
			</section>

			<p id="status" class="status"></p>

			<section class="grid">
				<article class="card kpi">
					<h2>Task Summary</h2>
					<div id="taskSummary"></div>
				</article>

				<article class="card kpi">
					<h2>Node Summary</h2>
					<div id="nodeSummary"></div>
				</article>

				<article class="card half">
					<h3>Attention Tasks</h3>
					<div id="attentionTasks"></div>
				</article>

				<article class="card half">
					<h3>Attention Nodes</h3>
					<div id="attentionNodes"></div>
				</article>

				<article class="card wide">
					<h3>Recent Audit</h3>
					<div id="recentAudit"></div>
				</article>

				<article class="card wide">
					<h3>Research Experiments</h3>
					<div class="form-grid">
						<input id="expName" class="input" placeholder="Experiment name" value="Mutation Sweep" />
						<input id="expModel" class="input" placeholder="Model version" value="bio-llm-v1" />
						<input id="expSteps" class="input" type="number" min="10" value="1200" />
						<input id="expQuorum" class="input" type="number" min="1" value="1" />
						<input id="expMutation" class="input" type="number" min="0.001" max="1" step="0.001" value="0.02" />
						<input id="expPopulation" class="input" type="number" min="32" value="1024" />
					</div>
					<div class="form-row">
						<textarea id="expPrompt" class="textarea" placeholder="Research prompt">Find stable mutation regimes under resource constraints.</textarea>
					</div>
					<div class="form-row">
						<button id="createExperiment" class="button secondary" type="button">Create Experiment</button>
						<button id="refreshResearch" class="mini-btn" type="button">Refresh Research</button>
					</div>
				</article>

				<article class="card half">
					<h3>Experiment Queue</h3>
					<div id="researchList"></div>
				</article>

				<article class="card half">
					<h3>Experiment Details</h3>
					<div id="researchDetails" class="mono">Select an experiment to inspect.</div>
				</article>

				<article class="card wide">
					<h3>Research Trend (Best Score)</h3>
					<div id="researchTrend" class="trend-wrap mono">No completed experiments yet.</div>
				</article>

				<article class="card wide">
					<h3>Experiment Compare (A/B)</h3>
					<div class="compare-grid">
						<select id="compareA" class="input"></select>
						<select id="compareB" class="input"></select>
					</div>
					<div class="form-row">
						<button id="runCompare" class="mini-btn" type="button">Compare</button>
					</div>
					<div id="compareResult" class="mono">Choose two experiments and click Compare.</div>
				</article>
			</section>
		</main>

		<script>
			const els = {
				key: document.getElementById("key"),
				autoRefresh: document.getElementById("autoRefresh"),
				refresh: document.getElementById("refresh"),
				status: document.getElementById("status"),
				taskSummary: document.getElementById("taskSummary"),
				nodeSummary: document.getElementById("nodeSummary"),
				attentionTasks: document.getElementById("attentionTasks"),
				attentionNodes: document.getElementById("attentionNodes"),
				recentAudit: document.getElementById("recentAudit"),
				expName: document.getElementById("expName"),
				expModel: document.getElementById("expModel"),
				expSteps: document.getElementById("expSteps"),
				expQuorum: document.getElementById("expQuorum"),
				expMutation: document.getElementById("expMutation"),
				expPopulation: document.getElementById("expPopulation"),
				expPrompt: document.getElementById("expPrompt"),
				createExperiment: document.getElementById("createExperiment"),
				refreshResearch: document.getElementById("refreshResearch"),
				researchList: document.getElementById("researchList"),
				researchDetails: document.getElementById("researchDetails"),
				researchTrend: document.getElementById("researchTrend"),
				compareA: document.getElementById("compareA"),
				compareB: document.getElementById("compareB"),
				runCompare: document.getElementById("runCompare"),
				compareResult: document.getElementById("compareResult")
			};

			let autoRefreshTimer = null;
			let selectedExperimentId = null;
			let researchItems = [];
			let compareAId = null;
			let compareBId = null;

			function row(label, value, badgeClass) {
				const badge = badgeClass ? '<span class="badge ' + badgeClass + '">' + value + '</span>' : String(value);
				return '<div class="row"><span>' + label + '</span><span>' + badge + '</span></div>';
			}

			function age(ms) {
				if (ms === null || ms === undefined) return "n/a";
				if (ms < 1000) return ms + " ms";
				const seconds = Math.floor(ms / 1000);
				if (seconds < 60) return seconds + " s";
				return Math.floor(seconds / 60) + " min";
			}

			function renderDashboard(data) {
				els.taskSummary.innerHTML = [
					row("Total", data.tasks.total),
					row("Pending", data.tasks.pending),
					row("Leased", data.tasks.leased),
					row("Completed", data.tasks.completed, "ok"),
					row("Failed", data.tasks.failed, "warn")
				].join("");

				els.nodeSummary.innerHTML = [
					row("Total", data.nodes.total),
					row("Active", data.nodes.active),
					row("Enabled", data.nodes.enabled, "ok"),
					row("Disabled", data.nodes.disabled, data.nodes.disabled > 0 ? "warn" : "ok"),
					row("Quarantined", data.nodes.quarantined, data.nodes.quarantined > 0 ? "warn" : "ok")
				].join("");

				els.attentionTasks.innerHTML = data.attentionTasks.length
					? data.attentionTasks
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.snapshot.task.id.slice(0, 8) + '</strong><div class="mono">' +
									item.reason +
									' | attempts=' + item.details.attempts + ' | results=' + item.details.resultCount + ' | age=' + age(item.details.ageMs) +
									'</div></div></div>'
							)
							.join("")
					: '<div class="mono">No attention tasks.</div>';

				els.attentionNodes.innerHTML = data.attentionNodes.length
					? data.attentionNodes
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.snapshot.stats.nodeId + '</strong><div class="mono">' +
									item.reason +
									' | rej=' + item.details.rejected + ' | acc=' + item.details.accepted + ' | rejRate=' +
									Math.round(item.details.rejectionRate * 100) + '% | seen=' + age(item.details.lastSeenAgeMs) + '</div></div></div>'
							)
							.join("")
					: '<div class="mono">No attention nodes.</div>';

				els.recentAudit.innerHTML = data.recentAudit.length
					? data.recentAudit
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.eventType + '</strong><div class="mono">' +
									item.at +
									(item.taskId ? ' | task=' + item.taskId : '') +
									(item.nodeId ? ' | node=' + item.nodeId : '') +
									'</div></div></div>'
							)
							.join("")
					: '<div class="mono">No audit entries.</div>';
			}

			function toNumber(value, fallback) {
				const n = Number(value);
				if (!Number.isFinite(n)) return fallback;
				return n;
			}

			function renderResearchList(items) {
				if (!items.length) {
					els.researchList.innerHTML = '<div class="mono">No experiments yet.</div>';
					return;
				}

				els.researchList.innerHTML = items
					.map(
						(item) =>
							'<div class="row"><div><strong>' + item.name + '</strong><div class="mono">' +
							item.experimentId.slice(0, 8) + ' | ' + item.status + ' | best=' +
							(item.bestScore === null ? 'n/a' : item.bestScore.toFixed(3)) + '</div></div>' +
							'<button class="mini-btn" data-exp-id="' + item.experimentId + '">Open</button></div>'
					)
					.join('');

				els.researchList.querySelectorAll('[data-exp-id]').forEach((button) => {
					button.addEventListener('click', () => {
						selectedExperimentId = button.getAttribute('data-exp-id');
						void loadExperimentDetails();
					});
				});
			}

			function renderResearchTrend(items) {
				const points = items
					.filter((item) => typeof item.bestScore === 'number')
					.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

				if (!points.length) {
					els.researchTrend.innerHTML = 'No completed experiments yet.';
					return;
				}

				const width = 640;
				const height = 180;
				const padX = 34;
				const padY = 22;
				const innerWidth = width - padX * 2;
				const innerHeight = height - padY * 2;
				const maxScore = 1;
				const minScore = 0;

				const svgPoints = points
					.map((item, index) => {
						const x = padX + (points.length === 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
						const y = padY + (1 - (item.bestScore - minScore) / (maxScore - minScore)) * innerHeight;
						return { x, y, score: item.bestScore, name: item.name };
					});

				const path = svgPoints.map((p) => p.x.toFixed(1) + ',' + p.y.toFixed(1)).join(' ');
				const last = svgPoints[svgPoints.length - 1];
				const latest = points[points.length - 1];

				els.researchTrend.innerHTML =
					'<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-svg" role="img" aria-label="Research best score trend">' +
					'<line x1="' + padX + '" y1="' + (height - padY) + '" x2="' + (width - padX) + '" y2="' + (height - padY) + '" stroke="#d4e4f2" />' +
					'<line x1="' + padX + '" y1="' + padY + '" x2="' + padX + '" y2="' + (height - padY) + '" stroke="#d4e4f2" />' +
					'<polyline fill="none" stroke="#0ea5e9" stroke-width="3" points="' + path + '" />' +
					'<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="4" fill="#f59e0b" />' +
					'</svg>' +
					'<div>Latest: <strong>' + latest.name + '</strong> | best score=' + latest.bestScore.toFixed(3) + ' | runs=' + points.length + '</div>';
			}

			function renderCompareSelectors(items) {
				if (!items.length) {
					els.compareA.innerHTML = '<option value="">No experiments</option>';
					els.compareB.innerHTML = '<option value="">No experiments</option>';
					return;
				}

				if (!compareAId || !items.some((item) => item.experimentId === compareAId)) {
					compareAId = items[0].experimentId;
				}

				if (!compareBId || !items.some((item) => item.experimentId === compareBId)) {
					compareBId = items[Math.min(1, items.length - 1)].experimentId;
				}

				const optionsHtml = items
					.map((item) => '<option value="' + item.experimentId + '">' + item.name + ' (' + item.experimentId.slice(0, 8) + ')</option>')
					.join('');

				els.compareA.innerHTML = optionsHtml;
				els.compareB.innerHTML = optionsHtml;
				els.compareA.value = compareAId;
				els.compareB.value = compareBId;
			}

			function metric(item, key) {
				if (!item || !item.results || !item.results.length) {
					return null;
				}

				const latest = item.results[0];
				if (!latest || !latest.payload || !latest.payload.metrics) {
					return null;
				}

				const raw = latest.payload.metrics[key];
				return typeof raw === 'number' ? raw : null;
			}

			function renderDelta(label, a, b, higherIsBetter) {
				const an = typeof a === 'number' ? a : null;
				const bn = typeof b === 'number' ? b : null;
				if (an === null || bn === null) {
					return row(label, 'n/a');
				}

				const delta = an - bn;
				let badge = '';
				if (delta !== 0) {
					const betterA = higherIsBetter ? delta > 0 : delta < 0;
					badge = betterA ? 'ok' : 'warn';
				}

				const value =
					an.toFixed(3) + ' vs ' + bn.toFixed(3) + ' (Δ ' + (delta >= 0 ? '+' : '') + delta.toFixed(3) + ')';
				return row(label, value, badge);
			}

			async function loadExperimentById(experimentId) {
				const key = els.key.value.trim();
				if (!key || !experimentId) {
					return null;
				}

				const response = await fetch('/research/experiments/' + experimentId, {
					headers: { 'x-admin-key': key }
				});

				if (!response.ok) {
					return null;
				}

				return await response.json();
			}

			async function runCompare() {
				compareAId = els.compareA.value;
				compareBId = els.compareB.value;
				if (!compareAId || !compareBId) {
					els.compareResult.innerHTML = 'Choose two experiments first.';
					return;
				}

				const [a, b] = await Promise.all([loadExperimentById(compareAId), loadExperimentById(compareBId)]);
				if (!a || !b) {
					els.compareResult.innerHTML = 'Compare fetch failed.';
					return;
				}

				els.compareResult.innerHTML = [
					'<div class="mono"><strong>A:</strong> ' + a.name + ' | <strong>B:</strong> ' + b.name + '</div>',
					renderDelta('Best Score', a.bestScore, b.bestScore, true),
					renderDelta('Convergence', metric(a, 'convergence'), metric(b, 'convergence'), true),
					renderDelta('Stability', metric(a, 'stability'), metric(b, 'stability'), true),
					renderDelta('Diversity', metric(a, 'diversityIndex'), metric(b, 'diversityIndex'), true),
					renderDelta('Mutation Rate', a.mutationRate, b.mutationRate, false),
					renderDelta('Population', a.populationSize, b.populationSize, true)
				].join('');
			}

			function renderResearchDetails(item) {
				if (!item) {
					els.researchDetails.innerHTML = 'Select an experiment to inspect.';
					return;
				}

				const latest = item.results && item.results.length ? item.results[0] : null;
				const metrics = latest && latest.payload && latest.payload.metrics ? latest.payload.metrics : null;
				els.researchDetails.innerHTML = [
					row('Name', item.name),
					row('Status', item.status, item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'warn' : ''),
					row('Model', item.modelVersion),
					row('Steps', item.steps),
					row('Mutation', item.mutationRate),
					row('Population', item.populationSize),
					row('Best Score', item.bestScore === null ? 'n/a' : item.bestScore.toFixed(3), item.bestScore !== null && item.bestScore > 0.7 ? 'ok' : ''),
					row('Results', item.resultCount),
					'<div class="mono">Prompt: ' + item.prompt + '</div>',
					metrics
						? '<div class="mono">Metrics: conv=' + Number(metrics.convergence || 0).toFixed(3) +
							', stability=' + Number(metrics.stability || 0).toFixed(3) + ', diversity=' + Number(metrics.diversityIndex || 0).toFixed(3) + '</div>'
						: '<div class="mono">Metrics: n/a</div>'
				].join('');
			}

			async function loadResearchList() {
				const key = els.key.value.trim();
				if (!key) {
					return;
				}

				const response = await fetch('/research/experiments?limit=20', {
					headers: { 'x-admin-key': key }
				});

				if (!response.ok) {
					els.researchList.innerHTML = '<div class="mono">Research fetch failed: ' + response.status + '</div>';
					return;
				}

				const data = await response.json();
				researchItems = data.items || [];
				renderResearchList(researchItems);
				renderResearchTrend(researchItems);
				renderCompareSelectors(researchItems);
			}

			async function loadExperimentDetails() {
				const key = els.key.value.trim();
				if (!key || !selectedExperimentId) {
					return;
				}

				const response = await fetch('/research/experiments/' + selectedExperimentId, {
					headers: { 'x-admin-key': key }
				});

				if (!response.ok) {
					els.researchDetails.innerHTML = 'Experiment load failed: ' + response.status;
					return;
				}

				const item = await response.json();
				renderResearchDetails(item);
				renderResearchTrend(researchItems);
			}

			async function createExperiment() {
				const key = els.key.value.trim();
				if (!key) {
					els.status.textContent = 'Enter admin API key first.';
					return;
				}

				const payload = {
					name: els.expName.value.trim(),
					modelVersion: els.expModel.value.trim(),
					steps: Math.floor(toNumber(els.expSteps.value, 1200)),
					quorum: Math.floor(toNumber(els.expQuorum.value, 1)),
					mutationRate: toNumber(els.expMutation.value, 0.02),
					populationSize: Math.floor(toNumber(els.expPopulation.value, 1024)),
					prompt: els.expPrompt.value.trim()
				};

				els.status.textContent = 'Creating experiment...';
				const response = await fetch('/research/experiments', {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-admin-key': key
					},
					body: JSON.stringify(payload)
				});

				if (!response.ok) {
					const text = await response.text();
					els.status.textContent = 'Create failed: ' + response.status + ' ' + text;
					return;
				}

				const created = await response.json();
				selectedExperimentId = created.experimentId;
				els.status.textContent = 'Experiment created: ' + created.experimentId.slice(0, 8);
				await loadResearchList();
				await loadExperimentDetails();
			}

			async function loadAll() {
				await loadDashboard();
				await loadResearchList();
				if (selectedExperimentId) {
					await loadExperimentDetails();
				}
			}

			async function loadDashboard() {
				const key = els.key.value.trim();
				if (!key) {
					els.status.textContent = "Enter admin API key first.";
					return;
				}

				localStorage.setItem("bioSwarmAdminKey", key);

				els.status.textContent = "Loading dashboard...";

				try {
					const response = await fetch("/admin/dashboard", {
						headers: {
							"x-admin-key": key
						}
					});

					if (!response.ok) {
						const text = await response.text();
						els.status.textContent = "Dashboard fetch failed: " + response.status + " " + text;
						return;
					}

					const payload = await response.json();
					renderDashboard(payload);
					els.status.textContent = "Updated at " + new Date().toLocaleTimeString();
				} catch (error) {
					els.status.textContent = "Request failed: " + error;
				}
			}

			function syncAutoRefresh() {
				if (autoRefreshTimer !== null) {
					clearInterval(autoRefreshTimer);
					autoRefreshTimer = null;
				}

				if (!els.autoRefresh.checked) {
					localStorage.setItem("bioSwarmAutoRefresh", "off");
					return;
				}

				localStorage.setItem("bioSwarmAutoRefresh", "on");
				autoRefreshTimer = setInterval(() => {
					if (els.key.value.trim()) {
						void loadAll();
					}
				}, 5000);
			}

			const rememberedKey = localStorage.getItem("bioSwarmAdminKey");
			if (rememberedKey) {
				els.key.value = rememberedKey;
			}

			if (localStorage.getItem("bioSwarmAutoRefresh") === "off") {
				els.autoRefresh.checked = false;
			}

			els.refresh.addEventListener("click", () => {
				void loadAll();
			});
			els.refreshResearch.addEventListener("click", () => {
				void loadResearchList();
				if (selectedExperimentId) {
					void loadExperimentDetails();
				}
			});
			els.createExperiment.addEventListener("click", () => {
				void createExperiment();
			});
			els.runCompare.addEventListener('click', () => {
				void runCompare();
			});
			els.compareA.addEventListener('change', () => {
				compareAId = els.compareA.value;
			});
			els.compareB.addEventListener('change', () => {
				compareBId = els.compareB.value;
			});
			els.autoRefresh.addEventListener("change", syncAutoRefresh);
			els.key.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					void loadAll();
				}
			});

			syncAutoRefresh();
			if (els.key.value.trim()) {
				void loadAll();
			}
		</script>
	</body>
</html>`;
}
