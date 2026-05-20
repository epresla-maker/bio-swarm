export function renderAdminDashboardPage(): string {
	return `<!doctype html>
<html lang="hu">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Bio Swarm Operator Console</title>
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
					<p id="subtitle" class="subtitle">Elo figyelmi nezet a /admin/dashboard vegpontrol</p>
				</div>
				<div class="controls">
					<select id="language" class="input" style="min-width: 100px">
						<option value="hu">HU</option>
						<option value="en">EN</option>
					</select>
					<input id="key" class="input" type="password" placeholder="Admin API kulcs" />
					<label id="autoRefreshLabel" class="toggle"><input id="autoRefresh" type="checkbox" checked /> Auto 5 mp</label>
					<button id="refresh" class="button" type="button">Frissites</button>
				</div>
			</section>

			<p id="status" class="status"></p>

			<section class="grid">
				<article class="card kpi">
					<h2 id="taskSummaryTitle">Feladat Osszegzes</h2>
					<div id="taskSummary"></div>
				</article>

				<article class="card kpi">
					<h2 id="nodeSummaryTitle">Node Osszegzes</h2>
					<div id="nodeSummary"></div>
				</article>

				<article class="card wide">
					<h3 id="gpuNodesTitle">Desktop GPU Node-ok</h3>
					<div class="form-row">
						<label id="gpuActiveOnlyLabel" class="toggle"><input id="gpuActiveOnly" type="checkbox" /> Csak aktiv</label>
						<input id="gpuMinVram" class="input" type="number" min="0" step="1" value="0" style="min-width: 140px" />
					</div>
					<div id="gpuNodes"></div>
				</article>

				<article class="card half">
					<h3 id="attentionTasksTitle">Figyelmet Igenylo Feladatok</h3>
					<div id="attentionTasks"></div>
				</article>

				<article class="card half">
					<h3 id="attentionNodesTitle">Figyelmet Igenylo Node-ok</h3>
					<div id="attentionNodes"></div>
				</article>

				<article class="card wide">
					<h3 id="recentAuditTitle">Legutobbi Audit Esemenyek</h3>
					<div id="recentAudit"></div>
				</article>

				<article class="card wide">
					<h3 id="researchTitle">Kutatasi Kiserletek</h3>
					<div class="form-grid">
						<input id="expName" class="input" placeholder="Kiserlet neve" value="Mutacios Sepres" />
						<input id="expModel" class="input" placeholder="Modell verzio" value="bio-llm-v1" />
						<input id="expSteps" class="input" type="number" min="10" value="1200" />
						<input id="expQuorum" class="input" type="number" min="1" value="1" />
						<input id="expMutation" class="input" type="number" min="0.001" max="1" step="0.001" value="0.02" />
						<input id="expPopulation" class="input" type="number" min="32" value="1024" />
					</div>
					<div class="form-row">
						<textarea id="expPrompt" class="textarea" placeholder="Kutatasi prompt">Talald meg a stabil mutacios tartomanyokat eroforras korlat mellett.</textarea>
					</div>
					<div class="form-row">
						<button id="createExperiment" class="button secondary" type="button">Kiserlet Letrehozasa</button>
						<button id="refreshResearch" class="mini-btn" type="button">Kutatas Frissitese</button>
					</div>
				</article>

				<article class="card half">
					<h3 id="researchQueueTitle">Kiserlet Sor</h3>
					<div id="researchList"></div>
				</article>

				<article class="card half">
					<h3 id="researchDetailsTitle">Kiserlet Reszletek</h3>
					<div id="researchDetails" class="mono">Valassz egy kiserletet a reszletekhez.</div>
				</article>

				<article class="card wide">
					<h3 id="researchTrendTitle">Kutatasi Trend (Legjobb Pontszam)</h3>
					<div id="researchTrend" class="trend-wrap mono">Meg nincs befejezett kiserlet.</div>
				</article>

				<article class="card wide">
					<h3 id="compareTitle">Kiserlet Osszehasonlitas (A/B)</h3>
					<div class="compare-grid">
						<select id="compareA" class="input"></select>
						<select id="compareB" class="input"></select>
					</div>
					<div class="form-row">
						<button id="runCompare" class="mini-btn" type="button">Osszehasonlitas</button>
						<button id="exportCompareCsv" class="mini-btn" type="button">CSV Export</button>
						<button id="exportCompareJson" class="mini-btn" type="button">JSON Export</button>
					</div>
					<div id="compareResult" class="mono">Valassz ket kiserletet, majd kattints az Osszehasonlitas gombra.</div>
				</article>
			</section>
		</main>

		<script>
			const I18N = {
				hu: {
					subtitle: 'Elo figyelmi nezet a /admin/dashboard vegpontrol',
					keyPlaceholder: 'Admin API kulcs',
					auto5s: 'Auto 5 mp',
					refresh: 'Frissites',
					taskSummaryTitle: 'Feladat Osszegzes',
					nodeSummaryTitle: 'Node Osszegzes',
					attentionTasksTitle: 'Figyelmet Igenylo Feladatok',
					attentionNodesTitle: 'Figyelmet Igenylo Node-ok',
					recentAuditTitle: 'Legutobbi Audit Esemenyek',
					researchTitle: 'Kutatasi Kiserletek',
					researchQueueTitle: 'Kiserlet Sor',
					researchDetailsTitle: 'Kiserlet Reszletek',
					researchTrendTitle: 'Kutatasi Trend (Legjobb Pontszam)',
					compareTitle: 'Kiserlet Osszehasonlitas (A/B)',
					gpuNodesTitle: 'Desktop GPU Node-ok',
					gpuActiveOnly: 'Csak aktiv',
					gpuMinVramLabel: 'Min VRAM (GB)',
					expNamePlaceholder: 'Kiserlet neve',
					expModelPlaceholder: 'Modell verzio',
					expPromptPlaceholder: 'Kutatasi prompt',
					createExperiment: 'Kiserlet Letrehozasa',
					refreshResearch: 'Kutatas Frissitese',
					runCompare: 'Osszehasonlitas',
					compareHint: 'Valassz ket kiserletet, majd kattints az Osszehasonlitas gombra.',
					researchDetailsHint: 'Valassz egy kiserletet a reszletekhez.',
					researchTrendEmpty: 'Meg nincs befejezett kiserlet.',
					total: 'Osszes',
					pending: 'Fuggo',
					leased: 'Berletben',
					completed: 'Befejezett',
					failed: 'Sikertelen',
					active: 'Aktiv',
					enabled: 'Engedelyezett',
					disabled: 'Tiltott',
					quarantine: 'Karanten',
					inactive: 'Inaktiv',
					noAttentionTasks: 'Nincs figyelmet igenylo feladat.',
					noAttentionNodes: 'Nincs figyelmet igenylo node.',
					noAudit: 'Nincs audit esemeny.',
					noExperiments: 'Meg nincs kiserlet.',
					noGpuNodes: 'Nincs aktiv desktop GPU node.',
					gpuVram: 'VRAM',
					open: 'Megnyitas',
					noExperimentOption: 'Nincs kiserlet',
					runCompareFirst: 'Elobb futtasd az osszehasonlitast.',
					jsonExportDone: 'JSON export kesz.',
					csvExportDone: 'CSV export kesz.',
					pickTwoExperiments: 'Elobb valassz ket kiserletet.',
					compareLoadFailed: 'Az osszehasonlitas lekerese sikertelen.',
					experimentLoadFailed: 'Kiserlet betoltes sikertelen: ',
					researchListLoadFailed: 'Kutatasi lista lekerese sikertelen: ',
					compareLabelA: 'A',
					compareLabelB: 'B',
					metricBestScore: 'Legjobb pontszam',
					metricConvergence: 'Konvergencia',
					metricStability: 'Stabilitas',
					metricDiversity: 'Diverzitas',
					metricMutationRate: 'Mutacios rata',
					metricPopulation: 'Populacio',
					enterAdminKey: 'Elobb add meg az admin API kulcsot.',
					creatingExperiment: 'Kiserlet letrehozasa...',
					createFailed: 'Letrehozas sikertelen: ',
					experimentCreated: 'Kiserlet letrehozva: ',
					loadingDashboard: 'Vezerlopult betoltese...',
					dashboardLoadFailed: 'Vezerlopult lekeres sikertelen: ',
					updatedAt: 'Frissitve: ',
					requestFailed: 'Keres sikertelen: '
				},
				en: {
					subtitle: 'Live attention view from the /admin/dashboard endpoint',
					keyPlaceholder: 'Admin API key',
					auto5s: 'Auto 5s',
					refresh: 'Refresh',
					taskSummaryTitle: 'Task Summary',
					nodeSummaryTitle: 'Node Summary',
					attentionTasksTitle: 'Attention Tasks',
					attentionNodesTitle: 'Attention Nodes',
					recentAuditTitle: 'Recent Audit Events',
					researchTitle: 'Research Experiments',
					researchQueueTitle: 'Experiment Queue',
					researchDetailsTitle: 'Experiment Details',
					researchTrendTitle: 'Research Trend (Best Score)',
					compareTitle: 'Experiment Comparison (A/B)',
					gpuNodesTitle: 'Desktop GPU Nodes',
					gpuActiveOnly: 'Active only',
					gpuMinVramLabel: 'Min VRAM (GB)',
					expNamePlaceholder: 'Experiment name',
					expModelPlaceholder: 'Model version',
					expPromptPlaceholder: 'Research prompt',
					createExperiment: 'Create Experiment',
					refreshResearch: 'Refresh Research',
					runCompare: 'Compare',
					compareHint: 'Select two experiments, then click Compare.',
					researchDetailsHint: 'Select an experiment to inspect details.',
					researchTrendEmpty: 'No completed experiments yet.',
					total: 'Total',
					pending: 'Pending',
					leased: 'Leased',
					completed: 'Completed',
					failed: 'Failed',
					active: 'Active',
					enabled: 'Enabled',
					disabled: 'Disabled',
					quarantine: 'Quarantined',
					inactive: 'Inactive',
					noAttentionTasks: 'No attention tasks.',
					noAttentionNodes: 'No attention nodes.',
					noAudit: 'No audit events.',
					noExperiments: 'No experiments yet.',
					noGpuNodes: 'No desktop GPU nodes found.',
					gpuVram: 'VRAM',
					open: 'Open',
					noExperimentOption: 'No experiments',
					runCompareFirst: 'Run comparison first.',
					jsonExportDone: 'JSON export done.',
					csvExportDone: 'CSV export done.',
					pickTwoExperiments: 'Pick two experiments first.',
					compareLoadFailed: 'Failed to load comparison.',
					experimentLoadFailed: 'Failed to load experiment: ',
					researchListLoadFailed: 'Failed to load research list: ',
					compareLabelA: 'A',
					compareLabelB: 'B',
					metricBestScore: 'Best Score',
					metricConvergence: 'Convergence',
					metricStability: 'Stability',
					metricDiversity: 'Diversity',
					metricMutationRate: 'Mutation Rate',
					metricPopulation: 'Population',
					enterAdminKey: 'Enter admin API key first.',
					creatingExperiment: 'Creating experiment...',
					createFailed: 'Create failed: ',
					experimentCreated: 'Experiment created: ',
					loadingDashboard: 'Loading dashboard...',
					dashboardLoadFailed: 'Dashboard request failed: ',
					updatedAt: 'Updated: ',
					requestFailed: 'Request failed: '
				}
			};

			let language = localStorage.getItem('bioSwarmLanguage') === 'en' ? 'en' : 'hu';

			function t(key) {
				return (I18N[language] && I18N[language][key]) || (I18N.hu && I18N.hu[key]) || key;
			}

			const els = {
				language: document.getElementById('language'),
				subtitle: document.getElementById('subtitle'),
				key: document.getElementById("key"),
				autoRefreshLabel: document.getElementById('autoRefreshLabel'),
				autoRefresh: document.getElementById("autoRefresh"),
				refresh: document.getElementById("refresh"),
				status: document.getElementById("status"),
				taskSummaryTitle: document.getElementById('taskSummaryTitle'),
				nodeSummaryTitle: document.getElementById('nodeSummaryTitle'),
				attentionTasksTitle: document.getElementById('attentionTasksTitle'),
				attentionNodesTitle: document.getElementById('attentionNodesTitle'),
				gpuNodesTitle: document.getElementById('gpuNodesTitle'),
				gpuActiveOnlyLabel: document.getElementById('gpuActiveOnlyLabel'),
				gpuActiveOnly: document.getElementById('gpuActiveOnly'),
				gpuMinVram: document.getElementById('gpuMinVram'),
				recentAuditTitle: document.getElementById('recentAuditTitle'),
				researchTitle: document.getElementById('researchTitle'),
				researchQueueTitle: document.getElementById('researchQueueTitle'),
				researchDetailsTitle: document.getElementById('researchDetailsTitle'),
				researchTrendTitle: document.getElementById('researchTrendTitle'),
				compareTitle: document.getElementById('compareTitle'),
				taskSummary: document.getElementById("taskSummary"),
				nodeSummary: document.getElementById("nodeSummary"),
				attentionTasks: document.getElementById("attentionTasks"),
				attentionNodes: document.getElementById("attentionNodes"),
				gpuNodes: document.getElementById("gpuNodes"),
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
				exportCompareCsv: document.getElementById("exportCompareCsv"),
				exportCompareJson: document.getElementById("exportCompareJson"),
				compareResult: document.getElementById("compareResult")
			};

			function applyStaticLanguage() {
				document.documentElement.lang = language;
				els.language.value = language;
				els.subtitle.textContent = t('subtitle');
				els.key.placeholder = t('keyPlaceholder');
				els.autoRefreshLabel.lastChild.textContent = ' ' + t('auto5s');
				els.refresh.textContent = t('refresh');
				els.taskSummaryTitle.textContent = t('taskSummaryTitle');
				els.nodeSummaryTitle.textContent = t('nodeSummaryTitle');
				els.attentionTasksTitle.textContent = t('attentionTasksTitle');
				els.attentionNodesTitle.textContent = t('attentionNodesTitle');
				els.gpuNodesTitle.textContent = t('gpuNodesTitle');
				els.gpuActiveOnlyLabel.lastChild.textContent = ' ' + t('gpuActiveOnly');
				els.gpuMinVram.setAttribute('aria-label', t('gpuMinVramLabel'));
				els.gpuMinVram.title = t('gpuMinVramLabel');
				els.recentAuditTitle.textContent = t('recentAuditTitle');
				els.researchTitle.textContent = t('researchTitle');
				els.researchQueueTitle.textContent = t('researchQueueTitle');
				els.researchDetailsTitle.textContent = t('researchDetailsTitle');
				els.researchTrendTitle.textContent = t('researchTrendTitle');
				els.compareTitle.textContent = t('compareTitle');
				els.expName.placeholder = t('expNamePlaceholder');
				els.expModel.placeholder = t('expModelPlaceholder');
				els.expPrompt.placeholder = t('expPromptPlaceholder');
				els.createExperiment.textContent = t('createExperiment');
				els.refreshResearch.textContent = t('refreshResearch');
				els.runCompare.textContent = t('runCompare');
				if (!selectedExperimentId) {
					els.researchDetails.innerHTML = t('researchDetailsHint');
				}
				if (!researchItems.length) {
					els.researchTrend.innerHTML = t('researchTrendEmpty');
				}
				if (gpuNodeItems.length) {
					renderGpuNodes(gpuNodeItems);
				} else {
					els.gpuNodes.innerHTML = '<div class="mono">' + t('noGpuNodes') + '</div>';
				}
				if (!compareSnapshot) {
					els.compareResult.innerHTML = t('compareHint');
				}
			}

			let autoRefreshTimer = null;
			let selectedExperimentId = null;
			let researchItems = [];
			let gpuRawItems = [];
			let gpuNodeItems = [];
			let compareAId = null;
			let compareBId = null;
			let compareSnapshot = null;

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
					row(t('total'), data.tasks.total),
					row(t('pending'), data.tasks.pending),
					row(t('leased'), data.tasks.leased),
					row(t('completed'), data.tasks.completed, "ok"),
					row(t('failed'), data.tasks.failed, "warn")
				].join("");

				els.nodeSummary.innerHTML = [
					row(t('total'), data.nodes.total),
					row(t('active'), data.nodes.active),
					row(t('enabled'), data.nodes.enabled, "ok"),
					row(t('disabled'), data.nodes.disabled, data.nodes.disabled > 0 ? "warn" : "ok"),
					row(t('quarantine'), data.nodes.quarantined, data.nodes.quarantined > 0 ? "warn" : "ok")
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
					: '<div class="mono">' + t('noAttentionTasks') + '</div>';

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
					: '<div class="mono">' + t('noAttentionNodes') + '</div>';

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
					: '<div class="mono">' + t('noAudit') + '</div>';
			}

			function renderGpuNodes(items) {
				if (!items.length) {
					els.gpuNodes.innerHTML = '<div class="mono">' + t('noGpuNodes') + '</div>';
					return;
				}

				els.gpuNodes.innerHTML = items
					.map((item) => {
						const caps = item.capabilities || {};
						const gpu = caps.gpu || {};
						const mode = item.active ? t('active') : t('inactive');
						const badge = item.active ? 'ok' : 'warn';
						return (
							'<div class="row"><div><strong>' +
							item.stats.nodeId +
							'</strong><div class="mono">' +
							(gpu.vendor || 'unknown') +
							' ' +
							(gpu.model || 'gpu') +
							' | ' +
							t('gpuVram') +
							'=' +
							(gpu.vramGb ?? 'n/a') +
							' GB</div></div><span class="badge ' +
							badge +
							'">' +
							mode +
							'</span></div>'
						);
					})
					.join('');
			}

			function applyGpuFilters() {
				const activeOnly = Boolean(els.gpuActiveOnly.checked);
				const minVramRaw = Number(els.gpuMinVram.value);
				const minVram = Number.isFinite(minVramRaw) ? Math.max(0, minVramRaw) : 0;

				gpuNodeItems = gpuRawItems.filter((item) => {
					if (activeOnly && !item.active) {
						return false;
					}

					const vram = Number(item.capabilities?.gpu?.vramGb ?? 0);
					if (Number.isFinite(vram) && vram < minVram) {
						return false;
					}

					if (!Number.isFinite(vram) && minVram > 0) {
						return false;
					}

					return true;
				});

				renderGpuNodes(gpuNodeItems);
			}

			function toNumber(value, fallback) {
				const n = Number(value);
				if (!Number.isFinite(n)) return fallback;
				return n;
			}

			function renderResearchList(items) {
				if (!items.length) {
					els.researchList.innerHTML = '<div class="mono">' + t('noExperiments') + '</div>';
					return;
				}

				els.researchList.innerHTML = items
					.map(
						(item) =>
							'<div class="row"><div><strong>' + item.name + '</strong><div class="mono">' +
							item.experimentId.slice(0, 8) + ' | ' + item.status + ' | best=' +
							(item.bestScore === null ? 'n/a' : item.bestScore.toFixed(3)) + '</div></div>' +
							'<button class="mini-btn" data-exp-id="' + item.experimentId + '">' + t('open') + '</button></div>'
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
					els.researchTrend.innerHTML = t('researchTrendEmpty');
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
					'<svg viewBox="0 0 ' + width + ' ' + height + '" class="trend-svg" role="img" aria-label="Kutatasi legjobb pontszam trend">' +
					'<line x1="' + padX + '" y1="' + (height - padY) + '" x2="' + (width - padX) + '" y2="' + (height - padY) + '" stroke="#d4e4f2" />' +
					'<line x1="' + padX + '" y1="' + padY + '" x2="' + padX + '" y2="' + (height - padY) + '" stroke="#d4e4f2" />' +
					'<polyline fill="none" stroke="#0ea5e9" stroke-width="3" points="' + path + '" />' +
					'<circle cx="' + last.x.toFixed(1) + '" cy="' + last.y.toFixed(1) + '" r="4" fill="#f59e0b" />' +
					'</svg>' +
					'<div>Legutobbi: <strong>' + latest.name + '</strong> | legjobb pontszam=' + latest.bestScore.toFixed(3) + ' | futasok=' + points.length + '</div>';
			}

			function renderCompareSelectors(items) {
				if (!items.length) {
					els.compareA.innerHTML = '<option value="">' + t('noExperimentOption') + '</option>';
					els.compareB.innerHTML = '<option value="">' + t('noExperimentOption') + '</option>';
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

			function getCompareRows(a, b) {
				return [
					{
						metric: t('metricBestScore'),
						a: a.bestScore,
						b: b.bestScore,
						delta:
							typeof a.bestScore === 'number' && typeof b.bestScore === 'number' ? a.bestScore - b.bestScore : null
					},
					{
						metric: t('metricConvergence'),
						a: metric(a, 'convergence'),
						b: metric(b, 'convergence'),
						delta:
							typeof metric(a, 'convergence') === 'number' && typeof metric(b, 'convergence') === 'number'
								? metric(a, 'convergence') - metric(b, 'convergence')
								: null
					},
					{
						metric: t('metricStability'),
						a: metric(a, 'stability'),
						b: metric(b, 'stability'),
						delta:
							typeof metric(a, 'stability') === 'number' && typeof metric(b, 'stability') === 'number'
								? metric(a, 'stability') - metric(b, 'stability')
								: null
					},
					{
						metric: t('metricDiversity'),
						a: metric(a, 'diversityIndex'),
						b: metric(b, 'diversityIndex'),
						delta:
							typeof metric(a, 'diversityIndex') === 'number' && typeof metric(b, 'diversityIndex') === 'number'
								? metric(a, 'diversityIndex') - metric(b, 'diversityIndex')
								: null
					},
					{
						metric: t('metricMutationRate'),
						a: a.mutationRate,
						b: b.mutationRate,
						delta:
							typeof a.mutationRate === 'number' && typeof b.mutationRate === 'number'
								? a.mutationRate - b.mutationRate
								: null
					},
					{
						metric: t('metricPopulation'),
						a: a.populationSize,
						b: b.populationSize,
						delta:
							typeof a.populationSize === 'number' && typeof b.populationSize === 'number'
								? a.populationSize - b.populationSize
								: null
					}
				];
			}

			function downloadTextFile(fileName, mimeType, text) {
				const blob = new Blob([text], { type: mimeType });
				const href = URL.createObjectURL(blob);
				const link = document.createElement('a');
				link.href = href;
				link.download = fileName;
				document.body.appendChild(link);
				link.click();
				link.remove();
				URL.revokeObjectURL(href);
			}

			function toCsvCell(value) {
				const raw = value === null || value === undefined ? '' : String(value);
				if (raw.includes(',') || raw.includes('"') || raw.includes('\\n')) {
					return '"' + raw.replace(/"/g, '""') + '"';
				}
				return raw;
			}

			function exportCompare(format) {
				if (!compareSnapshot) {
					els.status.textContent = t('runCompareFirst');
					return;
				}

				const stamp = new Date().toISOString().replace(/[:.]/g, '-');
				if (format === 'json') {
					downloadTextFile(
						'compare-' + stamp + '.json',
						'application/json;charset=utf-8',
						JSON.stringify(compareSnapshot, null, 2)
					);
					els.status.textContent = t('jsonExportDone');
					return;
				}

				const header = ['metric', 'a', 'b', 'delta'];
				const rows = compareSnapshot.rows.map((row) => [
					row.metric,
					row.a,
					row.b,
					row.delta
				]);
				const csv = [header, ...rows]
					.map((line) => line.map((cell) => toCsvCell(cell)).join(','))
					.join('\\n');
				downloadTextFile('compare-' + stamp + '.csv', 'text/csv;charset=utf-8', csv);
				els.status.textContent = t('csvExportDone');
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
					els.compareResult.innerHTML = t('pickTwoExperiments');
					return;
				}

				const [a, b] = await Promise.all([loadExperimentById(compareAId), loadExperimentById(compareBId)]);
				if (!a || !b) {
					els.compareResult.innerHTML = t('compareLoadFailed');
					return;
				}

				const rows = getCompareRows(a, b);
				compareSnapshot = {
					generatedAt: new Date().toISOString(),
					a: { id: a.experimentId, name: a.name },
					b: { id: b.experimentId, name: b.name },
					rows
				};

				els.compareResult.innerHTML = [
					'<div class="mono"><strong>' + t('compareLabelA') + ':</strong> ' + a.name + ' | <strong>' + t('compareLabelB') + ':</strong> ' + b.name + '</div>',
					renderDelta(t('metricBestScore'), a.bestScore, b.bestScore, true),
					renderDelta(t('metricConvergence'), metric(a, 'convergence'), metric(b, 'convergence'), true),
					renderDelta(t('metricStability'), metric(a, 'stability'), metric(b, 'stability'), true),
					renderDelta(t('metricDiversity'), metric(a, 'diversityIndex'), metric(b, 'diversityIndex'), true),
					renderDelta(t('metricMutationRate'), a.mutationRate, b.mutationRate, false),
					renderDelta(t('metricPopulation'), a.populationSize, b.populationSize, true)
				].join('');
			}

			function renderResearchDetails(item) {
				if (!item) {
					els.researchDetails.innerHTML = t('researchDetailsHint');
					return;
				}

				const latest = item.results && item.results.length ? item.results[0] : null;
				const metrics = latest && latest.payload && latest.payload.metrics ? latest.payload.metrics : null;
				els.researchDetails.innerHTML = [
					row('Nev', item.name),
					row('Allapot', item.status, item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'warn' : ''),
					row('Modell', item.modelVersion),
					row('Lepesek', item.steps),
					row('Mutacio', item.mutationRate),
					row('Populacio', item.populationSize),
					row('Legjobb pontszam', item.bestScore === null ? 'n/a' : item.bestScore.toFixed(3), item.bestScore !== null && item.bestScore > 0.7 ? 'ok' : ''),
					row('Eredmenyek', item.resultCount),
					'<div class="mono">Prompt: ' + item.prompt + '</div>',
					metrics
						? '<div class="mono">Metrikak: konvergencia=' + Number(metrics.convergence || 0).toFixed(3) +
							', stabilitas=' + Number(metrics.stability || 0).toFixed(3) + ', diverzitas=' + Number(metrics.diversityIndex || 0).toFixed(3) + '</div>'
						: '<div class="mono">Metrikak: n/a</div>'
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
					els.researchList.innerHTML = '<div class="mono">' + t('researchListLoadFailed') + response.status + '</div>';
					return;
				}

				const data = await response.json();
				researchItems = data.items || [];
				renderResearchList(researchItems);
				renderResearchTrend(researchItems);
				renderCompareSelectors(researchItems);
			}

			async function loadGpuNodes() {
				try {
					const response = await fetch('/nodes?limit=100');
					if (!response.ok) {
						return;
					}

					const data = await response.json();
					const items = Array.isArray(data.items) ? data.items : [];
					gpuRawItems = items.filter(
						(item) => item && item.capabilities && item.capabilities.nodeClass === 'desktop_gpu' && item.capabilities.gpu
					);
					applyGpuFilters();
				} catch (_error) {
					// Keep dashboard usable even if optional GPU list fetch fails.
				}
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
					els.researchDetails.innerHTML = t('experimentLoadFailed') + response.status;
					return;
				}

				const item = await response.json();
				renderResearchDetails(item);
				renderResearchTrend(researchItems);
			}

			async function createExperiment() {
				const key = els.key.value.trim();
				if (!key) {
					els.status.textContent = t('enterAdminKey');
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

				els.status.textContent = t('creatingExperiment');
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
					els.status.textContent = t('createFailed') + response.status + ' ' + text;
					return;
				}

				const created = await response.json();
				selectedExperimentId = created.experimentId;
				els.status.textContent = t('experimentCreated') + created.experimentId.slice(0, 8);
				await loadResearchList();
				await loadExperimentDetails();
			}

			async function loadAll() {
				await loadDashboard();
				await loadGpuNodes();
				await loadResearchList();
				if (selectedExperimentId) {
					await loadExperimentDetails();
				}
			}

			async function loadDashboard() {
				const key = els.key.value.trim();
				if (!key) {
					els.status.textContent = t('enterAdminKey');
					return;
				}

				localStorage.setItem("bioSwarmAdminKey", key);

				els.status.textContent = t('loadingDashboard');

				try {
					const response = await fetch("/admin/dashboard", {
						headers: {
							"x-admin-key": key
						}
					});

					if (!response.ok) {
						const text = await response.text();
						els.status.textContent = t('dashboardLoadFailed') + response.status + " " + text;
						return;
					}

					const payload = await response.json();
					renderDashboard(payload);
					els.status.textContent = t('updatedAt') + new Date().toLocaleTimeString();
				} catch (error) {
					els.status.textContent = t('requestFailed') + error;
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

			applyStaticLanguage();

			if (localStorage.getItem("bioSwarmAutoRefresh") === "off") {
				els.autoRefresh.checked = false;
			}

			els.refresh.addEventListener("click", () => {
				void loadAll();
			});
			els.language.addEventListener('change', () => {
				language = els.language.value === 'en' ? 'en' : 'hu';
				localStorage.setItem('bioSwarmLanguage', language);
				applyStaticLanguage();
				if (els.key.value.trim()) {
					void loadAll();
					if (els.compareA.value && els.compareB.value) {
						void runCompare();
					}
				}
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
			els.exportCompareCsv.addEventListener('click', () => {
				exportCompare('csv');
			});
			els.exportCompareJson.addEventListener('click', () => {
				exportCompare('json');
			});
			els.compareA.addEventListener('change', () => {
				compareAId = els.compareA.value;
			});
			els.compareB.addEventListener('change', () => {
				compareBId = els.compareB.value;
			});
			els.gpuActiveOnly.addEventListener('change', () => {
				applyGpuFilters();
			});
			els.gpuMinVram.addEventListener('input', () => {
				applyGpuFilters();
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
