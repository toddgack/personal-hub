const get = id => document.getElementById(id);
const colors = ['#d7a5ff', '#ffac79', '#80e0d7', '#ff9ec9'];
const fieldsExcluded = new Set(['PlayerID','Player_ID','Player','Position','PositionGroup','Position_Group',
  'Week','WeekNumber','Week_Number','teamlabel','team.label','teamid','team.id','Jersey','RefreshDate','Refresh_Date','runningStyle']);
const groupNames = {QB:'Quarterbacks',RB:'Running backs',WR:'Wide receivers',TE:'Tight ends',OL:'Offensive line',
  DL:'Defensive line',LB:'Linebackers',DB:'Defensive backs',ST:'Special teams',Other:'Other'};
const number = new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const label = key => key.replace(/([A-Z]+)([A-Z][a-z])/g,'$1 $2').replace(/([a-z])([A-Z])/g,'$1 $2')
  .replace(/^./, char => char.toUpperCase());
const weekLabel = week => week === 0 ? 'Launch' : 'Week ' + week;
const valueText = value => value === null ? '—' : number.format(value);
const deltaText = value => value === null ? '—' : (value > 0 ? '+' : '') + number.format(value);
const numeric = value => value === null || value === undefined || (typeof value === 'string' && !value.trim()) ||
  (typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value)) ? null : Number(value);
const rating = value => { const n = numeric(value); return n !== null && n >= 0 && n <= 100 ? n : null; };

let data;
let state;
let rosterLimit = 20;
const pinned = new Set();
const chartModels = new Map();

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function domoSnapshot(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('The mapped Domo dataset returned no rows.');
  const keys = new Set();
  for (const row of records) for (const key of Object.keys(row)) keys.add(key);
  const fields = ['Overall', ...[...keys].filter(key => key !== 'Overall' && !fieldsExcluded.has(key) &&
    records.some(row => rating(row[key]) !== null)).sort()];
  return { source:'Domo · Madden Data', refreshed:records[0].RefreshDate ?? records[0].Refresh_Date, fields,
    rows:records.map(row => [row.PlayerID ?? row.Player_ID,row.Player,row.teamlabel ?? row['team.label'] ?? 'Unassigned',
      row.Position,row.PositionGroup ?? row.Position_Group,numeric(row.WeekNumber ?? row.Week_Number),
      ...fields.map(key => rating(row[key]))]) };
}

async function fetchData() {
  if (document.documentElement.dataset.source === 'domo') {
    if (!window.domo?.get) throw new Error('Open this package in Domo with the MaddenData dataset mapped.');
    const rows = await window.domo.get('/data/v1/MaddenData?limit=100000');
    if (rows.length >= 100000) throw new Error('The Domo result hit the row limit. A complete snapshot is required.');
    return domoSnapshot(rows);
  }
  const response = await fetch('/madden-data.txt');
  if (!response.ok) throw new Error('The ratings snapshot could not be downloaded.');
  const bytes = Uint8Array.from(atob((await response.text()).trim()), char => char.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).json();
}

function buildIndex(snapshot) {
  if (!Array.isArray(snapshot.fields) || !Array.isArray(snapshot.rows) || !snapshot.fields.includes('Overall')) {
    throw new Error('The ratings data is missing required fields.');
  }
  const byWeek = new Map(), byPlayer = new Map(), teams = new Set(), groups = new Set();
  for (const [idValue,name,teamValue,positionValue,groupValue,week,...ratings] of snapshot.rows) {
    if (idValue == null || String(idValue).trim() === '' || typeof name !== 'string' || !name.trim() ||
        !Number.isInteger(week) || week < 0) throw new Error('The data contains an invalid player or week.');
    const id = String(idValue), team = teamValue || 'Unassigned', position = positionValue || 'Other', group = groupValue || 'Other';
    const row = {id,name,team,position,group,week,ratings};
    if (!byWeek.has(week)) byWeek.set(week,[]);
    if (!byPlayer.has(id)) byPlayer.set(id,new Map());
    if (byPlayer.get(id).has(week)) throw new Error('Duplicate player and week found in the data.');
    byWeek.get(week).push(row);
    byPlayer.get(id).set(week,row);
    teams.add(team); groups.add(group);
  }
  if (!byWeek.size) throw new Error('The snapshot contains no player records.');
  return { ...snapshot, byWeek, byPlayer, teams:[...teams].sort(), groups:[...groups].sort(),
    weeks:[...byWeek.keys()].sort((a,b)=>a-b) };
}

function fill(id, values, selected) {
  const select = get(id);
  select.replaceChildren(...values.map(([value,name])=>new Option(name,value)));
  if (values.some(([value])=>String(value)===String(selected))) select.value=String(selected);
}

function initializeFilters() {
  const teams = [['*','All NFL teams'], ...data.teams.map(team=>[team,team])];
  const groups = [['*','All positions'], ...data.groups.map(group=>[group,groupNames[group] ?? group])];
  fill('team-a',teams,data.teams.find(team=>team.endsWith('Bears')) ?? '*');
  fill('team-b',[['','No comparison'],...teams],data.teams.find(team=>team.endsWith('Packers')) ?? '*');
  for (const id of ['group-a','group-b']) fill(id,groups,data.groups.includes('OL') ? 'OL' : '*');
  fill('metric',data.fields.map((name,i)=>[i,label(name)]),data.fields.indexOf('Overall'));
  const weeks = data.weeks.map(week=>[week,weekLabel(week)]);
  fill('from',weeks,data.weeks[0]); fill('to',weeks,data.weeks.at(-1));
  const refresh = typeof data.refreshed === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(data.refreshed)?.[0] : null;
  get('source').textContent = (data.source || 'Madden NFL 27') + (refresh ? ' · Snapshot ' + refresh : '');
}

function groupSeries(team,group,weeks,metric,basis) {
  const snapshots = weeks.map(week=>data.byWeek.get(week).filter(row=>
    (team === '*' ? row.team !== 'Unassigned' : row.team === team) &&
    (group === '*' || row.group === group) && rating(row.ratings[metric]) !== null));
  const shared = new Map();
  if (basis === 'fixed') for (const rows of snapshots) for (const row of rows) shared.set(row.id,(shared.get(row.id) ?? 0)+1);
  const rosters = basis === 'fixed' ? snapshots.map(rows=>rows.filter(row=>shared.get(row.id)===weeks.length)) : snapshots;
  const points = rosters.map(rows=>rows.length ? rows.reduce((sum,row)=>sum+rating(row.ratings[metric]),0)/rows.length : null);
  return {name:(team==='*' ? 'NFL' : team) + ' · ' + (groupNames[group] ?? (group==='*' ? 'All positions' : group)),
    rosters,points};
}

function rosterRows(group, metric) {
  const first = new Map(group.rosters[0].map(row=>[row.id,row]));
  const last = new Map(group.rosters.at(-1).map(row=>[row.id,row]));
  return [...new Set([...first.keys(),...last.keys()])].map(id=>{
    const a=first.get(id), b=last.get(id);
    const start=a ? rating(a.ratings[metric]) : null, end=b ? rating(b.ratings[metric]) : null;
    return {id, name:(b ?? a).name, position:(b ?? a).position, start, end,
      change:start===null || end===null ? null : end-start, membership:!a ? 'End only' : !b ? 'Start only' : 'Both'};
  });
}

function table(id, headings, rows) {
  const head=node('thead'), headRow=node('tr'), body=node('tbody');
  for(const heading of headings){ const cell=node('th',heading);cell.scope='col';headRow.append(cell); }
  head.append(headRow);
  for(const values of rows){
    const row=node('tr');
    for(const value of values){const cell=node('td');if(typeof value==='string')cell.textContent=value;else cell.append(value);row.append(cell);}
    body.append(row);
  }
  if(!rows.length){
    const row=node('tr'), cell=node('td','No matching records.');cell.colSpan=headings.length;row.append(cell);body.append(row);
  }
  get(id).replaceChildren(head,body);
}

function metricCard(title, value, detail) {
  const card=node('div',undefined,'metric');
  card.append(node('dt',title),node('dd',value),node('small',detail));
  return card;
}

function graph(id,legendId,weeks,series,delta) {
  const model = {weeks,series,delta};
  chartModels.set(id,model);
  const legend = series.map(item=>{
    const entry=node('span'), swatch=node('span',undefined,'swatch');
    swatch.style.background=item.color; entry.append(swatch,item.name);return entry;
  });
  get(legendId).replaceChildren(...legend);
  draw(id);
}

function draw(id) {
  const canvas=get(id), model=chartModels.get(id);
  if(!model) return;
  const rect=canvas.getBoundingClientRect();
  if(rect.width < 1 || rect.height < 1) return;
  const dpr=window.devicePixelRatio || 1;
  canvas.width=Math.round(rect.width*dpr); canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d'), width=rect.width, height=rect.height;
  ctx.scale(dpr,dpr); ctx.font='12px system-ui'; ctx.fillStyle='#c9b5d0';
  const values=model.series.flatMap(item=>item.points.filter(value=>value!==null));
  if(!values.length){ctx.fillText('No ratings for this selection.',12,26);model.bounds=null;return;}
  if(model.delta) values.push(0);
  const lo=Math.min(...values), hi=Math.max(...values), spread=Math.max(hi-lo,2);
  const magnitude=10**Math.floor(Math.log10(spread/4));
  const step=[1,2,2.5,5,10].map(x=>x*magnitude).find(x=>x>=spread/4);
  let min=Math.floor((lo-spread*.08)/step)*step, max=Math.ceil((hi+spread*.08)/step)*step;
  if(!model.delta){min=Math.max(0,min);max=Math.min(100,max);}
  const left=42, right=width-19, top=12, bottom=height-28;
  const x=i=>model.weeks.length===1 ? (left+right)/2 : left+(right-left)*i/(model.weeks.length-1);
  const y=value=>bottom-(value-min)*(bottom-top)/(max-min);
  model.bounds={left,right,x};
  ctx.textAlign='right';
  for(let tick=Math.ceil(min/step)*step;tick<=max+1e-8;tick+=step){
    const h=y(tick);ctx.strokeStyle=model.delta && Math.abs(tick)<1e-8 ? '#a78eb6' : '#f2d4ff25';
    ctx.beginPath();ctx.moveTo(left,h);ctx.lineTo(right,h);ctx.stroke();
    ctx.fillText(valueText(Math.abs(tick)<1e-8 ? 0 : tick),left-7,h+4);
  }
  ctx.textAlign='center';
  const stride=Math.ceil(model.weeks.length/Math.max(2,Math.floor((right-left)/54)));
  model.weeks.forEach((week,i)=>{
    if(i%stride===0 && (i===0 || i<model.weeks.length-1 || stride===1))
      ctx.fillText(week===0?'Launch':'W'+week,x(i),height-8);
  });
  for(const item of model.series){
    ctx.strokeStyle=item.color;ctx.fillStyle=item.color;ctx.lineWidth=2.5;ctx.beginPath();
    let started=false;
    item.points.forEach((value,i)=>{
      if(value===null){started=false;return;}
      if(started) ctx.lineTo(x(i),y(value)); else ctx.moveTo(x(i),y(value));
      started=true;
    });
    ctx.stroke();
    item.points.forEach((value,i)=>{if(value!==null){ctx.beginPath();ctx.arc(x(i),y(value),3.5,0,Math.PI*2);ctx.fill();}});
  }
}

function bindChart(id,tipId) {
  const canvas=get(id),tip=get(tipId);
  new ResizeObserver(()=>draw(id)).observe(canvas);
  canvas.addEventListener('pointermove',event=>{
    const model=chartModels.get(id); if(!model?.bounds)return;
    const {left,right}=model.bounds;
    const x=event.clientX-canvas.getBoundingClientRect().left;
    const index=Math.max(0,Math.min(model.weeks.length-1,Math.round((x-left)/(right-left)*(model.weeks.length-1))));
    tip.textContent=[weekLabel(model.weeks[index]),...model.series.map(item=>item.name+': '+
      (model.delta ? deltaText(item.points[index]) : valueText(item.points[index])))].join('\n');
    tip.hidden=false;tip.style.left=Math.max(0,Math.min(x+10,canvas.clientWidth-tip.offsetWidth))+'px';tip.style.top='5px';
  });
  canvas.addEventListener('pointerleave',()=>{tip.hidden=true;});
}

function bars(id,items,empty) {
  if(!items.length){get(id).replaceChildren(node('p',empty,'empty'));return;}
  const max=Math.max(1,...items.map(item=>Math.abs(item.value)));
  get(id).replaceChildren(...items.map(item=>{
    const row=node('div',undefined,'bar-row'), bar=node('div',undefined,item.value<0?'bar negative':'bar'), fill=node('span');
    fill.style.width=Math.abs(item.value)/max*100+'%';
    bar.append(fill);bar.setAttribute('aria-hidden','true');
    row.append(node('span',item.label),bar,node('span',item.text,'bar-value'));return row;
  }));
}

function renderRoster() {
  const group=get('roster-group').value==='b' && state.groups[1] ? state.groups[1] : state.groups[0];
  const rows=rosterRows(group,state.metric);
  const search=get('search').value.trim().toLowerCase(), sort=get('sort').value;
  const filtered=rows.filter(row=>row.name.toLowerCase().includes(search));
  const sorters={latest:(a,b)=>(b.end??-Infinity)-(a.end??-Infinity),
    up:(a,b)=>(b.change??-Infinity)-(a.change??-Infinity),down:(a,b)=>(a.change??Infinity)-(b.change??Infinity),
    name:()=>0};
  filtered.sort((a,b)=>sorters[sort](a,b) || a.name.localeCompare(b.name));
  get('roster-count').textContent=filtered.length+' players · '+group.name;
  const end=state.weeks.at(-1);
  const buckets = new Map();
  for(const row of group.rosters.at(-1)){
    const bucket=Math.min(90,Math.floor(rating(row.ratings[state.metric])/10)*10);
    buckets.set(bucket,(buckets.get(bucket)??0)+1);
  }
  get('distribution-note').textContent=group.name+' · '+weekLabel(end);
  bars('distribution',[...buckets].sort(([a],[b])=>a-b).map(([bucket,count])=>({
    label:bucket+'–'+(bucket===90?100:bucket+9),value:count,text:String(count)})),'No rated players in the final week.');
  const movers=rows.filter(row=>row.change!==null && row.change!==0)
    .sort((a,b)=>Math.abs(b.change)-Math.abs(a.change) || a.name.localeCompare(b.name)).slice(0,6);
  get('movers-note').textContent=group.name+' · players rated at both endpoints';
  bars('movers',movers.map(row=>({label:row.name,value:row.change,text:deltaText(row.change)})),
    'No rating changes for players with values at both endpoints.');
  table('roster',['Player','Pos','Start','End','Change','Roster','Player chart'],filtered.slice(0,rosterLimit).map(row=>{
    const button=node('button',pinned.has(row.id)?'Remove':'Compare');button.type='button';
    button.setAttribute('aria-label',(pinned.has(row.id)?'Remove ':'Compare ')+row.name);
    button.addEventListener('click',()=>{
      if(pinned.has(row.id)) pinned.delete(row.id);
      else if(pinned.size>=4){get('compare-note').textContent='Remove a player before adding another. You can compare up to four.';return;}
      else pinned.add(row.id);
      renderRoster(); renderPlayers();
      get('compare-note').textContent=pinned.size ? pinned.size+' selected · See Player history below.' :
        'Select Compare beside up to four players to chart their ratings.';
    });
    return [window.openMaddenProfile ? actionLink(row.name,()=>window.openMaddenProfile(row.id,state.weeks.at(-1))) : row.name,row.position,valueText(row.start),valueText(row.end),deltaText(row.change),row.membership,button];
  }));
  get('more').hidden=rosterLimit>=filtered.length;
}

function renderPlayers() {
  get('player-panel').hidden=!pinned.size;
  if(!pinned.size)return;
  const series=[...pinned].map((id,i)=>{
    const rows=data.byPlayer.get(id);
    const name=[...rows.values()].at(-1).name;
    return {id,name,color:colors[i],points:state.weeks.map(week=>rating(rows.get(week)?.ratings[state.metric]))};
  });
  get('player-chips').replaceChildren(...series.map(item=>{
    const button=node('button',item.name+' ×');button.type='button';
    button.setAttribute('aria-label','Remove '+item.name);
    button.addEventListener('click',()=>{pinned.delete(item.id);renderRoster();renderPlayers();});
    return button;
  }));
  graph('player-trend','player-legend',state.weeks,series,false);
  table('player-values',['Week',...series.map(item=>item.name)],state.weeks.map((week,i)=>
    [weekLabel(week),...series.map(item=>valueText(item.points[i]))]));
}

function render() {
  const first=Number(get('from').value),last=Number(get('to').value), metric=Number(get('metric').value);
  const weeks=data.weeks.filter(week=>week>=first&&week<=last),basis=get('basis').value;
  const groups=[groupSeries(get('team-a').value,get('group-a').value,weeks,metric,basis)];
  if(get('team-b').value) groups.push(groupSeries(get('team-b').value,get('group-b').value,weeks,metric,basis));
  get('roster-group').options[1].disabled=groups.length===1;
  if(groups.length===1)get('roster-group').value='a';
  const end=weeks.at(-1), delta=get('scale').value==='delta';
  state={groups,weeks,metric};
  get('span-label').textContent=label(data.fields[metric])+' · '+weekLabel(first)+' to '+weekLabel(end);
  const stats=groups.map(group=>{
    const start=group.points[0], finish=group.points.at(-1),change=start===null||finish===null?null:finish-start;
    return metricCard(group.name,valueText(finish),deltaText(change)+' vs '+weekLabel(first)+' · '+group.rosters.at(-1).length+' rated players');
  });
  if(groups.length===2){
    const a=groups[0].points.at(-1),b=groups[1].points.at(-1);
    stats.push(metricCard('Group A minus Group B',deltaText(a===null||b===null?null:a-b),'Average rating difference · '+weekLabel(end)));
  }
  get('metrics').replaceChildren(...stats);
  graph('trend','trend-legend',weeks,groups.map((group,i)=>({name:group.name,color:colors[i],points:
    delta ? group.points.map(value=>value===null||group.points[0]===null?null:value-group.points[0]) : group.points})),delta);
  table('weekly',['Week',...groups.flatMap((group,i)=>['Group '+(i?'B':'A')+' avg','Group '+(i?'B':'A')+' players'])],
    weeks.map((week,i)=>[weekLabel(week),...groups.flatMap(group=>[valueText(group.points[i]),String(group.rosters[i].length)])]));
  get('method').textContent=(basis==='fixed'?'Fixed roster includes players with this rating in the selected team and group for every update in the range.':
    'Weekly rosters use each update’s team assignments. Adds, departures, and rating changes can all move the average.')+
    ' Missing ratings are excluded.';
  renderRoster(); renderPlayers();
}

async function load() {
  const status=get('loading'),title=status.querySelector('h2');
  title.textContent='Loading ratings history…';get('load-note').textContent='';get('retry').hidden=true;
  try{
    data=buildIndex(await fetchData());
    initializeFilters();status.hidden=true;get('dashboard').hidden=false;window.dispatchEvent(new Event('madden-ready'));
  }catch(error){
    status.hidden=false;get('dashboard').hidden=true;title.textContent='Ratings unavailable';
    get('load-note').textContent=error.message;get('retry').hidden=false;
  }
}

for (const id of ['team-a','group-a','team-b','group-b','metric','from','to','basis','scale']) {
  get(id).addEventListener('change',()=>{
    if(Number(get('from').value)>Number(get('to').value)) {
      if(id==='from')get('to').value=get('from').value;
      else get('from').value=get('to').value;
    }
    rosterLimit=20;render();
  });
}
for(const id of ['roster-group','sort','search'])get(id).addEventListener(id==='search'?'input':'change',()=>{rosterLimit=20;renderRoster();});
get('more').addEventListener('click',()=>{rosterLimit+=20;renderRoster();});
get('clear-players').addEventListener('click',()=>{pinned.clear();renderRoster();renderPlayers();});
get('retry').addEventListener('click',load);
bindChart('trend','trend-tip');
bindChart('player-trend','player-tip');
