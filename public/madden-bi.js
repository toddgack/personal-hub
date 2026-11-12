const positionMetrics = {
  QB: 'throwPower throwAccuracyShort throwAccuracyMid throwAccuracyDeep throwUnderPressure throwOnTheRun playAction awareness breakSack speed',
  RB: 'speed acceleration agility changeOfDirection bCVision carrying breakTackle trucking stiffArm jukeMove spinMove catching',
  WR: 'catching catchInTraffic spectacularCatch shortRouteRunning mediumRouteRunning deepRouteRunning release speed acceleration agility changeOfDirection jumping',
  TE: 'catching catchInTraffic spectacularCatch shortRouteRunning mediumRouteRunning deepRouteRunning release runBlock passBlock impactBlocking strength speed',
  OL: 'passBlock passBlockPower passBlockFinesse runBlock runBlockPower runBlockFinesse impactBlocking leadBlock strength awareness',
  DL: 'blockShedding powerMoves finesseMoves tackle pursuit hitPower strength acceleration playRecognition',
  LB: 'tackle pursuit hitPower blockShedding playRecognition awareness zoneCoverage manCoverage speed acceleration',
  DB: 'manCoverage zoneCoverage press playRecognition pursuit tackle hitPower speed acceleration agility jumping catching',
  ST: 'kickPower kickAccuracy kickReturn leadBlock impactBlocking awareness speed'
};
const groupOrder = ['QB','RB','WR','TE','OL','DL','LB','DB','ST','Other'];
const viewNames = ['position','league','team','player','fan','trends','reports'];
const teamMatches = (row, team) => team === '*' ? row.team !== 'Unassigned' : row.team === team;
const groupMatches = (row, group) => group === '*' || row.group === group;
const mean = values => values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
const diff = (end,start) => end===null || start===null ? null : end-start;
const fieldIndex = new Map();
const playerDirectory = [];
const positionState = {attributes:[], sort:'Overall', ascending:false, page:0, exportRows:[]};
const positionPageSize = 30;
let profileId;
let biReady = false;

function attributes(group, position) {
  let preferred = positionMetrics[group];
  if (group==='ST' && ['K','P'].includes(position)) preferred='kickPower kickAccuracy awareness';
  if (group==='ST' && position==='LS') preferred='leadBlock impactBlocking strength awareness';
  return ['Overall', ...(preferred ?? 'speed acceleration agility strength awareness').split(' ')]
    .filter(key=>fieldIndex.has(key));
}

function stat(row,key) { return rating(row?.ratings[fieldIndex.get(key)]); }
function statMean(rows,key) { return mean(rows.map(row=>stat(row,key)).filter(value=>value!==null)); }
function shortGroup(group) { return groupNames[group] ?? group; }
function weekValue(id) { return Number(get(id).value); }
function showText(id,text) { get(id).textContent=text; }
function setCards(id,values) { get(id).replaceChildren(...values.map(value=>metricCard(...value))); }
function rowsFor(week,team='*',group='*') {
  return data.byWeek.get(week).filter(row=>teamMatches(row,team)&&groupMatches(row,group));
}
function actionLink(text,callback) {
  const button=node('button',text,'table-link');
  button.type='button';button.addEventListener('click',callback);return button;
}
function playerLink(row) { return actionLink(row.name,()=>openProfile(row.id,row.week)); }

function activeView() {
  const hash=location.hash.slice(1);
  return viewNames.includes(hash) ? hash : 'position';
}

function showWorkspace() {
  if (!biReady) return;
  const selected=activeView();
  for (const view of viewNames) get('view-'+view).hidden=view!==selected;
  for (const item of get('workspaces').querySelectorAll('a')) {
    if (item.hash==='#'+selected) item.setAttribute('aria-current','page');
    else item.removeAttribute('aria-current');
  }
  const renders={position:renderPosition,league:renderLeague,team:renderTeam,player:renderProfile,fan:renderFan,trends:render,reports:renderReports};
  renders[selected]();
}

function navigate(view) {
  if(location.hash==='#'+view)showWorkspace();
  else location.hash=view;
  window.scrollTo(0,0);
}

function openProfile(id, week) {
  if(!data.byPlayer.has(id)) return;
  profileId=id;
  showText('profile-results','');
  get('profile-search').value='';
  const weeks=[...data.byPlayer.get(id).keys()].sort((a,b)=>a-b);
  fill('profile-week',weeks.map(w=>[w,weekLabel(w)]),weeks.includes(week)?week:weeks.at(-1));
  navigate('player');
}

function openPosition(team,group,week,base) {
  get('pos-team').value=team;
  get('pos-group').value=group;
  get('pos-week').value=String(week);
  get('pos-base').value=String(base);
  resetPosition();
  navigate('position');
}

function initializeBI() {
  data.fields.forEach((key,index)=>fieldIndex.set(key,index));
  for (const [id,snapshots] of data.byPlayer) {
    const row=snapshots.get(Math.max(...snapshots.keys()));
    playerDirectory.push({id,name:row.name,team:row.team,position:row.position});
  }
  playerDirectory.sort((a,b)=>a.name.localeCompare(b.name));
  const bears=data.teams.find(team=>team.endsWith('Bears')) ?? data.teams.find(team=>team!=='Unassigned');
  const teams=data.teams.filter(team=>team!=='Unassigned').map(team=>[team,team]);
  const groups=groupOrder.filter(group=>data.groups.includes(group)).map(group=>[group,shortGroup(group)]);
  fill('pos-group',groups,data.groups.includes('WR')?'WR':groups[0][0]);
  fill('pos-team',[['*','All NFL teams'],...teams], '*');
  fill('coach-team',teams,bears);
  fill('fan-group',[['*','All positions'],...groups],'*');
  const weeks=data.weeks.map(week=>[week,weekLabel(week)]);
  for (const id of ['pos-week','coach-week','league-week','fan-week']) fill(id,weeks,data.weeks.at(-1));
  fill('pos-base',weeks,data.weeks[0]);
  for(const id of ['coach-base','fan-base'])fill(id,weeks,data.weeks.at(-2)??data.weeks[0]);
  fillFanAttributes();
  fill('report-team',[['*','All NFL teams'],...teams], '*');
  fill('report-group',[['*','All positions'],...groups], '*');
  fill('report-from',weeks,data.weeks[0]);
  fill('report-to',weeks,data.weeks.at(-1));
  fillReportAttributes();
  resetPosition();
  profileId=rowsFor(data.weeks.at(-1),bears).sort((a,b)=>(stat(b,'Overall')??0)-(stat(a,'Overall')??0))[0]?.id ??
    playerDirectory[0].id;
  const profileWeeks=[...data.byPlayer.get(profileId).keys()].sort((a,b)=>a-b);
  fill('profile-week',profileWeeks.map(week=>[week,weekLabel(week)]),profileWeeks.at(-1));
  get('snapshot-caption').textContent=get('source').textContent+' · '+weekLabel(data.weeks[0])+' to '+weekLabel(data.weeks.at(-1));
  biReady=true;
  showWorkspace();
}

function resetPosition() {
  const fields=attributes(get('pos-group').value);
  positionState.attributes=fields.slice();
  positionState.sort='Overall';
  positionState.ascending=false;
  positionState.page=0;
  get('pos-attributes').replaceChildren(...fields.map(key=>{
    const option=node('label');
    const input=node('input');input.type='checkbox';input.checked=true;
    input.addEventListener('change',()=>{
      const selected=positionState.attributes;
      if(!input.checked && selected.length===1){input.checked=true;return;}
      positionState.attributes=fields.filter(item=>item===key ? input.checked : selected.includes(item));
      if(!positionState.attributes.includes(positionState.sort)&&positionState.sort!=='Player')positionState.sort=positionState.attributes[0];
      positionState.page=0;
      renderPosition();
    });
    option.append(input,label(key));return option;
  }));
  const lines=fields.map(key=>[key,label(key)]);
  fill('pos-line-a',lines,fields[1]??'Overall');
  fill('pos-line-b',[['','None'],...lines],fields[2]??'');
}

function heatFill(value, change) {
  if(value===null)return '';
  if(change){
    const t=Math.min(Math.abs(value)/12,1);
    return 'color-mix(in srgb,'+(value<0?'#9c3b17':'#6f3397')+' '+Math.round(t*100)+'%,#2d1b39)';
  }
  const percent=Math.max(0,Math.min(100,value));
  return 'color-mix(in srgb,#7a369c '+percent+'%,#2d1b39)';
}

function heatTable(fields,rows,change) {
  const head=node('thead'), header=node('tr');
  for(const key of ['Player','Team','Pos',...fields]){
    const cell=node('th');cell.scope='col';
    if(key==='Team'||key==='Pos') cell.textContent=key;
    else{
      const active=positionState.sort===key;
      if(active)cell.setAttribute('aria-sort',positionState.ascending?'ascending':'descending');
      const title=node('button',label(key)+(active?(positionState.ascending?' ↑':' ↓'):''));title.type='button';
      title.addEventListener('click',()=>{
        positionState.ascending=active?!positionState.ascending:key==='Player';
        positionState.sort=key;positionState.page=0;renderPosition();
      });
      cell.append(title);
    }
    header.append(cell);
  }
  head.append(header);
  const body=node('tbody');
  for(const row of rows){
    const tr=node('tr'), name=node('td');
    name.append(playerLink(row.player));
    tr.append(name,node('td',row.player.team),node('td',row.player.position));
    for(const key of fields){
      const value=row.values[key], cell=node('td',change?deltaText(value):valueText(value));
      if(value!==null){cell.dataset.value='';cell.style.background=heatFill(value,change);}
      cell.title=row.player.name+' · '+label(key)+': '+cell.textContent;
      tr.append(cell);
    }
    body.append(tr);
  }
  if(!rows.length){
    const row=node('tr'),cell=node('td','No players match your filters.');cell.colSpan=fields.length+3;row.append(cell);body.append(row);
  }
  get('heatmap').replaceChildren(head,body);
}

function spreadMarker(min,median,max) {
  const track=node('span',undefined,'spread'), range=node('span'), marker=node('i');
  track.setAttribute('aria-hidden','true');
  range.style.left=min+'%';range.style.width=Math.max(2,max-min)+'%';
  marker.style.left=median+'%';track.append(range,marker);
  return track;
}

function renderPosition() {
  const team=get('pos-team').value, group=get('pos-group').value, week=weekValue('pos-week'), base=weekValue('pos-base');
  const change=get('pos-mode').value==='change', search=get('pos-search').value.trim().toLowerCase();
  const fields=positionState.attributes;
  const roster=rowsFor(week,team,group).filter(row=>row.name.toLowerCase().includes(search));
  const prepared=roster.map(player=>{
    const before=data.byPlayer.get(player.id).get(base);
    const values=Object.fromEntries(fields.map(key=>[key,change?diff(stat(player,key),stat(before,key)):stat(player,key)]));
    return {player,values};
  });
  const sort=positionState.sort,sign=positionState.ascending?1:-1;
  prepared.sort((a,b)=>{
    if(sort==='Player')return sign*a.player.name.localeCompare(b.player.name);
    const x=a.values[sort],y=b.values[sort];
    if(x===null||y===null)return Number(x===null)-Number(y===null)||a.player.name.localeCompare(b.player.name);
    return sign*(x-y)||a.player.name.localeCompare(b.player.name);
  });
  positionState.exportRows=[['Player','Team','Position',...fields.map(label)],...prepared.map(({player,values})=>
    [player.name,player.team,player.position,...fields.map(key=>values[key]??'')])];
  const maxPage=Math.max(0,Math.ceil(prepared.length/positionPageSize)-1);
  positionState.page=Math.min(positionState.page,maxPage);
  const offset=positionState.page*positionPageSize;
  heatTable(fields,prepared.slice(offset,offset+positionPageSize),change);
  showText('pos-page',prepared.length?(offset+1)+'–'+Math.min(offset+positionPageSize,prepared.length)+' of '+prepared.length+' players':'0 players');
  get('pos-prev').disabled=positionState.page===0;get('pos-next').disabled=positionState.page>=maxPage;
  get('pos-export').disabled=!prepared.length;
  showText('pos-summary',prepared.length+' players · '+shortGroup(group)+' · '+weekLabel(week)+
    (change?' vs '+weekLabel(base):'')+' · '+(team==='*'?'All NFL teams':team));
  const gradient=node('span',undefined,'heat-gradient '+(change?'change':'rating'));
  get('pos-legend').replaceChildren(node('span',change?'−12 or less':'0'),gradient,
    node('span',change?'+12 or more':'100'),node('span',change?'— No comparable rating · Matched by player ID':'— Missing rating · Scroll for more attributes'));
  table('pos-spread',['Attribute','Low','Median','High','0–100','Rated'],fields.map(key=>{
    const values=roster.map(row=>stat(row,key)).filter(value=>value!==null).sort((a,b)=>a-b);
    if(!values.length)return [label(key),'—','—','—','—','0'];
    const low=values[0], high=values.at(-1),median=(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2;
    return [label(key),valueText(low),valueText(median),valueText(high),spreadMarker(low,median,high),String(values.length)];
  }));
  const weeks=data.weeks.filter(w=>w<=week);
  const keys=[...new Set([get('pos-line-a').value,get('pos-line-b').value].filter(Boolean))];
  const series=keys.map((key,i)=>({name:label(key),color:colors[i],points:weeks.map(w=>statMean(rowsFor(w,team,group),key))}));
  graph('pos-trend','pos-legend-chart',weeks,series,false);
  table('pos-weekly',['Update',...keys.map(label)],weeks.map((w,i)=>[weekLabel(w),...series.map(s=>valueText(s.points[i]))]));
}

function teamScore(week,team,group='*') { return statMean(rowsFor(week,team,group),'Overall'); }

function renderLeague() {
  const week=weekValue('league-week'),previous=data.weeks[data.weeks.indexOf(week)-1];
  const teams=data.teams.filter(team=>team!=='Unassigned').map(team=>{
    const overall=teamScore(week,team);
    return {team,overall,change:previous===undefined?null:diff(overall,teamScore(previous,team))};
  }).filter(row=>row.overall!==null).sort((a,b)=>b.overall-a.overall||a.team.localeCompare(b.team));
  const rows=rowsFor(week);
  const best=teams[0];
  const mover=teams.filter(row=>row.change!==null&&row.change>0).sort((a,b)=>b.change-a.change)[0];
  setCards('league-metrics',[
    ['Rated players',String(rows.filter(row=>stat(row,'Overall')!==null).length),weekLabel(week)],
    ['NFL mean overall',valueText(statMean(rows,'Overall')),'Unweighted player average'],
    ['Top team',best?.team??'—',best?valueText(best.overall)+' average overall':''],
    ['Biggest team gain',mover?.team??'—',mover?deltaText(mover.change)+' vs '+weekLabel(previous):'No positive change available']
  ]);
  table('league-teams',['Team','Rank','Avg overall','Change vs prior'],teams.map((row,i)=>[
    actionLink(row.team,()=>{
      get('coach-team').value=row.team;get('coach-week').value=String(week);
      get('coach-base').value=String(previous??week);navigate('team');
    }),String(i+1),valueText(row.overall),deltaText(row.change)]));
  table('league-groups',['Position group','Avg overall','Players','Change vs prior'],groupOrder.filter(group=>data.groups.includes(group)).map(group=>{
      const groupRows=rowsFor(week,'*',group);
      return [actionLink(shortGroup(group),()=>openPosition('*',group,week,previous??week)),
        valueText(statMean(groupRows,'Overall')),String(groupRows.length),
        deltaText(previous===undefined?null:diff(statMean(groupRows,'Overall'),teamScore(previous,'*',group)))];
    }));
}

function renderTeam() {
  const team=get('coach-team').value,week=weekValue('coach-week'),base=weekValue('coach-base');
  const roster=rowsFor(week,team).sort((a,b)=>(stat(b,'Overall')??-1)-(stat(a,'Overall')??-1)||a.name.localeCompare(b.name));
  const overall=statMean(roster,'Overall');
  const ranked=data.teams.filter(name=>name!=='Unassigned').map(name=>teamScore(week,name)).filter(v=>v!==null);
  const previous=new Set(rowsFor(base,team).map(row=>row.id));
  const current=new Set(roster.map(row=>row.id));
  setCards('coach-metrics',[
    ['Team overall',valueText(overall),'Avg rating · '+weekLabel(week)],
    ['NFL rank',overall===null?'—':String(1+ranked.filter(value=>value>overall).length),'Of '+ranked.length+' rated teams'],
    ['Roster movement',[...current].filter(id=>!previous.has(id)).length+' in · '+[...previous].filter(id=>!current.has(id)).length+' out','vs '+weekLabel(base)]
  ]);
  const groups=groupOrder.filter(group=>roster.some(row=>row.group===group));
  table('coach-groups',['Position group','Players','Avg overall','Change vs baseline','vs NFL avg'],groups.map(group=>{
    const players=roster.filter(row=>row.group===group), value=statMean(players,'Overall');
    return [actionLink(shortGroup(group),()=>openPosition(team,group,week,base)),String(players.length),valueText(value),
      deltaText(diff(value,teamScore(base,team,group))),deltaText(diff(value,teamScore(week,'*',group)))];
  }));
  table('coach-roster',['Player','Pos','Overall','Change vs baseline'],roster.map(row=>[
    playerLink(row),row.position,valueText(stat(row,'Overall')),deltaText(diff(stat(row,'Overall'),stat(data.byPlayer.get(row.id).get(base),'Overall')))]));
}

function renderProfileSearch() {
  const term=get('profile-search').value.trim().toLowerCase();
  const matches=term?playerDirectory.filter(player=>player.name.toLowerCase().includes(term)).slice(0,12):[];
  get('profile-results').replaceChildren(...(term&&!matches.length?[node('span','No matching players.','muted')]:
    matches.map(row=>actionLink(row.name+' · '+row.position+' · '+row.team,()=>openProfile(row.id)))));
}

function renderProfile() {
  const history=data.byPlayer.get(profileId), week=weekValue('profile-week'), row=history.get(week);
  const fields=attributes(row.group,row.position);
  const peersAt=update=>rowsFor(update,'*',row.group).filter(peer=>row.group!=='ST'||peer.position===row.position);
  const peerRows=peersAt(week), peerLabel=row.group==='ST'?row.position:shortGroup(row.group).toLowerCase();
  const ranked=row.team!=='Unassigned';
  const weeks=data.weeks, previous=weeks[weeks.indexOf(week)-1];
  const old=history.get(previous);
  const overall=stat(row,'Overall');
  const peers=peerRows.map(peer=>stat(peer,'Overall')).filter(v=>v!==null);
  const rank=!ranked||overall===null||!peers.length?'—':String(1+peers.filter(v=>v>overall).length);
  showText('profile-name',row.name);
  showText('profile-mark',row.name.split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase());
  showText('profile-meta',row.team+' · '+row.position+' · '+shortGroup(row.group)+' · '+weekLabel(week));
  setCards('profile-metrics',[
    ['Overall',valueText(overall),weekLabel(week)],
    ['Change vs previous update',deltaText(diff(overall,stat(old,'Overall'))),previous===undefined?'Launch snapshot':weekLabel(previous)],
    ['NFL position rank',rank,'Of '+peers.length+' rated '+peerLabel]
  ]);
  table('profile-attributes',['Attribute','Rating','Change','NFL avg','NFL rank'],fields.map(key=>{
    const value=stat(row,key), rated=peerRows.map(peer=>stat(peer,key)).filter(v=>v!==null);
    const peerRank=!ranked||value===null||!rated.length?'—':(1+rated.filter(v=>v>value).length)+' / '+rated.length;
    return [label(key),valueText(value),deltaText(diff(value,stat(old,key))),valueText(mean(rated)),peerRank];
  }));
  const oldKey=get('profile-rating').value;
  fill('profile-rating',fields.map(key=>[key,label(key)]),fields.includes(oldKey)?oldKey:'Overall');
  const metric=get('profile-rating').value;
  const series=[{name:row.name,color:colors[0],points:weeks.map(w=>stat(history.get(w),metric))},
    {name:'NFL '+peerLabel+' avg',color:colors[1],points:weeks.map(w=>statMean(peersAt(w),metric))}];
  graph('profile-trend','profile-legend',weeks,series,false);
  table('profile-values',['Update','Player','Position avg'],weeks.map((w,i)=>[weekLabel(w),...series.map(item=>valueText(item.points[i]))]));
}

function fillFanAttributes() {
  const group=get('fan-group').value;
  const keys=group==='*'?data.fields:attributes(group);
  fill('fan-metric',keys.map(key=>[key,label(key)]),keys.includes(get('fan-metric').value)?get('fan-metric').value:'Overall');
}

function renderFan() {
  const week=weekValue('fan-week'),base=weekValue('fan-base'),group=get('fan-group').value,key=get('fan-metric').value;
  const rows=rowsFor(week,'*',group).map(row=>{
    const value=stat(row,key),start=stat(data.byPlayer.get(row.id).get(base),key);
    return {row,value,start,change:diff(value,start)};
  }).filter(item=>item.value!==null);
  const headings=['Player','Team','Position','Rating','Change'];
  function renderBoard(id,items){
    table(id,headings,items.slice(0,12).map(({row,value,change})=>[
      playerLink(row),row.team,row.position,valueText(value),deltaText(change)]));
  }
  const movers=rows.filter(item=>item.change!==null).sort((a,b)=>b.change-a.change||a.row.name.localeCompare(b.row.name));
  renderBoard('fan-up',movers.filter(item=>item.change>0));
  renderBoard('fan-down',movers.filter(item=>item.change<0).reverse());
  renderBoard('fan-top',rows.sort((a,b)=>b.value-a.value||a.row.name.localeCompare(b.row.name)));
}

function downloadCSVRows(filename, dataRows) {
  const escaped=value=>{
    const text=String(value);
    const safe=typeof value==='string' && /^[=+@\-\t\r]/.test(text) ? "'"+text : text;
    return '"'+safe.replaceAll('"','""')+'"';
  };
  const rows=dataRows.map(row=>row.map(escaped).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([rows],{type:'text/csv;charset=utf-8'}));
  const link=node('a');link.href=url;
  link.download=filename;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

let reportRows = [];
function fillReportAttributes() {
  const group=get('report-group').value;
  const keys=group==='*'?data.fields:attributes(group);
  fill('report-rating',keys.map(key=>[key,label(key)]),keys.includes(get('report-rating').value)?get('report-rating').value:'Overall');
}

function renderReports() {
  const team=get('report-team').value, group=get('report-group').value, key=get('report-rating').value;
  const from=weekValue('report-from'), to=weekValue('report-to');
  const level=get('report-level').value, type=get('report-stat').value;
  const results=[];
  for(const week of data.weeks.filter(w=>w>=from&&w<=to)){
    const groups=new Map();
    for(const row of rowsFor(week,team,group)){
      const value=stat(row,key);
      if(value===null)continue;
      const id=level==='team'?row.team:level==='position'?row.group:row.id;
      if(!groups.has(id))groups.set(id,{name:level==='team'?row.team:level==='position'?shortGroup(row.group):row.name,values:[]});
      groups.get(id).values.push(value);
    }
    const snapshot=[...groups.values()].map(({name,values})=>{
      let value=mean(values);
      if(type!=='average'){
        values.sort((a,b)=>a-b);
        value=type==='min'?values[0]:type==='max'?values.at(-1):
          (values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2;
      }
      return {name,value,count:values.length};
    }).sort((a,b)=>b.value-a.value||a.name.localeCompare(b.name));
    for(const row of snapshot)results.push([weekLabel(week),row.name,row.value,row.count]);
  }
  const headings=['Update',label(level),label(type)+' '+label(key),'Rated players'];
  reportRows=[headings,...results];
  showText('report-note',results.length.toLocaleString()+' rows · '+(results.length>50?'Showing the first 50. The CSV includes all rows.':'All matching rows shown.'));
  get('report-export').disabled=!results.length;
  table('report-table',headings,results.slice(0,50).map(([week,name,value,count])=>[week,name,valueText(value),String(count)]));
}

function bind(ids, event, callback) { for(const id of ids)get(id).addEventListener(event,callback); }
bind(['pos-group'],'change',()=>{resetPosition();renderPosition();});
get('pos-reset').addEventListener('click',()=>{resetPosition();renderPosition();});
bind(['pos-team','pos-week','pos-base','pos-mode','pos-line-a','pos-line-b'],'change',()=>{positionState.page=0;renderPosition();});
get('pos-search').addEventListener('input',()=>{positionState.page=0;renderPosition();});
get('pos-prev').addEventListener('click',()=>{positionState.page--;renderPosition();});
get('pos-next').addEventListener('click',()=>{positionState.page++;renderPosition();});
get('pos-export').addEventListener('click',()=>downloadCSVRows(
  'madden-'+get('pos-group').value.toLowerCase()+'-'+get('pos-mode').value+'-week-'+get('pos-week').value+'.csv',positionState.exportRows));
bind(['league-week'],'change',renderLeague);
bind(['coach-team','coach-week','coach-base'],'change',renderTeam);
get('team-open-trends').addEventListener('click',()=>{
  get('team-a').value=get('coach-team').value;
  get('group-a').value='*';
  get('team-b').value='';
  get('to').value=get('coach-week').value;
  get('from').value=String(Math.min(weekValue('coach-base'),weekValue('coach-week')));
  navigate('trends');
});
get('profile-search').addEventListener('input',renderProfileSearch);
bind(['profile-week','profile-rating'],'change',renderProfile);
bind(['fan-group'],'change',()=>{fillFanAttributes();renderFan();});
bind(['fan-week','fan-base','fan-metric'],'change',renderFan);
bind(['report-team','report-rating','report-level','report-stat'],'change',renderReports);
bind(['report-group'],'change',()=>{fillReportAttributes();renderReports();});
for(const id of ['report-from','report-to'])get(id).addEventListener('change',()=>{
  if(weekValue('report-from')>weekValue('report-to')){
    get(id==='report-from'?'report-to':'report-from').value=get(id).value;
  }
  renderReports();
});
get('report-export').addEventListener('click',()=>downloadCSVRows('madden-ratings-report.csv',reportRows));
bindChart('pos-trend','pos-tip');
bindChart('profile-trend','profile-tip');
window.addEventListener('hashchange',()=>{window.scrollTo(0,0);showWorkspace();});
window.addEventListener('madden-ready',initializeBI);
window.openMaddenProfile=openProfile;
load();
