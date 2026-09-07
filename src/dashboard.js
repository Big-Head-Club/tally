// The admin page. One HTML string, no build. Dark monospace, live over SSE.
export function dashboardHtml({ base, tz }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analytics</title>
<style>
:root{--bg:#1c1a17;--fg:#e8e2d8;--dim:#9a9184;--line:#3a352f;--card:#26231f;--acc:#e6a54a;--ok:#8fc98a;--bad:#e07a6a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:32px 20px 80px}
main{max-width:920px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:40px 0 12px;font-weight:500}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.nav{color:var(--dim);margin-bottom:20px}.nav select,.nav button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font:inherit}
.tiles{display:flex;flex-wrap:wrap;gap:8px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 18px;min-width:130px}
.tile b{display:block;font-size:24px;color:var(--acc);font-weight:600}.tile span{color:var(--dim);font-size:12px}
.tile.live b{color:var(--ok)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:500;font-size:11px}
th:first-child,td:first-child{text-align:left}td.z{color:var(--line)}.wrap{overflow-x:auto}
.best{color:var(--acc);font-weight:600}.muted{color:var(--dim);font-size:12px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
#ticker{font-size:12px;color:var(--dim);max-height:320px;overflow:auto}#ticker div{padding:2px 0;border-bottom:1px solid var(--line)}#ticker .n{color:var(--fg)}#ticker .new{color:var(--ok)}
.bump{animation:bump .5s}@keyframes bump{from{color:var(--ok)}to{color:inherit}}
.err{color:var(--bad)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--bad);margin-right:6px}.dot.on{background:var(--ok)}
</style></head><body><main>
<h1>Analytics</h1>
<div class="nav"><span class="dot" id="dot"></span><span id="sitewrap">site <select id="site"></select></span> · last <select id="days"><option>7</option><option>14</option><option selected>30</option><option>90</option></select> days · times in ${esc(tz)} · <a id="csv" href="#">csv</a> · <a id="jsonl" href="#">jsonl</a></div>
<div id="app"><p class="muted">loading…</p></div>
<h2>Live</h2>
<div id="ticker"><div class="muted">waiting for events…</div></div>
<p class="muted" style="margin-top:40px">To hide your own visits, open any page of the site with <code>?tally=ignore</code> once on each device. <code>?tally=track</code> turns it back on.</p>
</main>
<script>
var BASE=${JSON.stringify(base)}, S={}, site=new URLSearchParams(location.search).get('site')||'', es=null, sites=[];
var $=function(s){return document.querySelector(s)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function n(v){return v==null?'—':Number(v).toLocaleString()}
function fmtT(ms){var d=new Date(ms);return d.toLocaleTimeString([],{hour12:false})}
function secs(s){if(s==null)return '—';s=Math.round(s);return s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s'}
async function loadSites(){sites=await (await fetch(BASE+'/sites.json?days='+$('#days').value)).json();var sel=$('#site');sel.innerHTML=sites.map(function(s){return '<option value="'+esc(s.site)+'">'+esc(s.site)+' ('+n(s.visitors)+')</option>'}).join('');if(!site&&sites[0])site=sites[0].site;sel.value=site;$('#sitewrap').style.display=sites.length>1?'':'none'}
async function load(){var days=$('#days').value;S=await (await fetch(BASE+'/stats.json?site='+encodeURIComponent(site)+'&days='+days)).json();$('#csv').href=BASE+'/export.csv?site='+encodeURIComponent(site);$('#jsonl').href=BASE+'/export.jsonl?site='+encodeURIComponent(site);render();connect()}
function render(){
  if(S.empty){$('#app').innerHTML='<p class="muted">No events yet. Add <code>&lt;script defer src="'+location.origin+'/t.js"&gt;&lt;/script&gt;</code> to a page and load it.</p>';return}
  var h='';
  h+='<div class="tiles">'+tile('live5m',S.live.visitors5m,'on site now','live')+tile('today_u',S.today.uniques,'visitors today')+tile('today_pv',S.today.pageviews,'pageviews today')+tile('all_u',S.allTimeVisitors,'visitors, all time')+tile('avg',secs(S.engagement.avgSeconds),'avg time on page')+'</div>';
  if(sites.length>1)h+='<h2>All sites</h2><div class="wrap"><table><tr><th>site</th><th>visitors</th><th>events</th><th>last seen</th></tr>'+sites.map(function(s){return '<tr><td><a href="?site='+encodeURIComponent(s.site)+'">'+esc(s.site)+'</a></td><td>'+n(s.visitors)+'</td><td>'+n(s.events)+'</td><td>'+new Date(s.last).toLocaleString()+'</td></tr>'}).join('')+'</table></div>';
  var names=S.names.slice(0,9),rest=S.names.slice(9);
  h+='<h2>Daily</h2><div class="wrap"><table id="daily"><tr><th>day</th><th>visitors</th>'+names.map(function(x){return '<th>'+esc(x)+'</th>'}).join('')+'</tr>';
  S.daily.slice(0,14).forEach(function(d){h+='<tr data-day="'+d.day+'"><td>'+d.day+'</td><td data-c="_u">'+n(d.uniques)+'</td>'+names.map(function(x){var c=d.counts[x];return '<td data-c="'+esc(x)+'"'+(c?'':' class="z"')+'>'+(c||'·')+'</td>'}).join('')+'</tr>'});
  h+='</table></div>';
  if(S.daily.length>14)h+='<p class="muted">table shows 14 days; tiles and lists cover the last '+S.days+'</p>';
  if(rest.length)h+='<p class="muted">also counted: '+rest.map(function(x){return esc(x)+' ('+n(S.totals[x])+')'}).join(', ')+'</p>';
  h+='<div class="cols">';
  h+=col('Referrers',S.refs,function(r){return [r.ref,r.u]},['source','visitors']);
  h+=col('Pages',S.paths,function(r){return [r.path,r.u]},['path','visitors']);
  h+=col('Clicks',S.clicks,function(r){return [r.t,r.c]},['element','clicks']);
  h+=col('Errors',S.errors,function(r){return ['<span class="err">'+esc(r.m)+'</span>',r.c]},['message','count'],true);
  h+='</div>';
  var dev=S.devices,tot=(dev.touch||0)+(dev.mouse||0);
  if(tot)h+='<p class="muted">touch '+Math.round(100*(dev.touch||0)/tot)+'% · mouse '+Math.round(100*(dev.mouse||0)/tot)+'% · first seen '+(S.firstSeen?new Date(S.firstSeen).toLocaleDateString():'—')+'</p>';
  Object.keys(S.ab).forEach(function(k){
    var arms=Object.keys(S.ab[k]).sort(),ev={};arms.forEach(function(a){Object.keys(S.ab[k][a].events).forEach(function(e){ev[e]=1})});
    var evs=Object.keys(ev).sort(function(a,b){return (S.totals[b]||0)-(S.totals[a]||0)}).slice(0,8);
    var best={};evs.forEach(function(e){best[e]=Math.max.apply(null,arms.map(function(a){return S.ab[k][a].events[e]||0}))});
    h+='<h2>A/B — '+esc(k)+'</h2><p class="muted">unique visitors per arm who did each event; best per column highlighted</p><div class="wrap"><table><tr><th>arm</th>'+evs.map(function(e){return '<th>'+esc(e)+'</th>'}).join('')+'</tr>';
    arms.forEach(function(a){h+='<tr><td>'+esc(a)+'</td>'+evs.map(function(e){var v=S.ab[k][a].events[e]||0;return '<td'+(v&&v===best[e]?' class="best"':'')+'>'+n(v)+'</td>'}).join('')+'</tr>'});
    h+='</table></div>';
  });
  $('#app').innerHTML=h;
  $('#ticker').innerHTML=S.recent.map(line).join('')||'<div class="muted">no events yet</div>';
}
function tile(id,v,label,cls){return '<div class="tile '+(cls||'')+'"><b id="t_'+id+'">'+(typeof v==='number'?n(v):esc(v))+'</b><span>'+label+'</span></div>'}
function col(title,rows,f,head,raw){if(!rows||!rows.length)return '<div><h2>'+title+'</h2><p class="muted">none</p></div>';return '<div><h2>'+title+'</h2><table><tr><th>'+head[0]+'</th><th>'+head[1]+'</th></tr>'+rows.map(function(r){var c=f(r);return '<tr><td>'+(raw?c[0]:esc(c[0]))+'</td><td>'+n(c[1])+'</td></tr>'}).join('')+'</table></div>'}
function line(e,fresh){var p=e.props||{};var extra=e.name==='click'?p.t:e.name==='pageview'?(e.ref?'from '+e.ref:'')+(p.touch?' touch':''):e.name==='leave'?secs(p.s):e.name==='error'?p.m:JSON.stringify(p).replace(/"/g,'').slice(0,80);return '<div'+(fresh?' class="new"':'')+'>'+fmtT(e.ts)+' <span class="n">'+esc(e.name)+'</span> '+esc(e.vid.slice(0,4))+' '+esc(e.path||'')+' <span>'+esc(extra||'')+'</span></div>'}
function bump(el){if(!el)return;el.classList.remove('bump');void el.offsetWidth;el.classList.add('bump')}
var reloadTimer=null;
function onEvent(e){
  if(!site||S.empty){site=e.site;$('#site').value=site;loadSites().then(load);return}
  if(e.site!==site)return;
  clearTimeout(reloadTimer);reloadTimer=setTimeout(load,2000);
  var t=$('#ticker');if(t.firstChild&&t.firstChild.className==='muted')t.innerHTML='';t.insertAdjacentHTML('afterbegin',line(e,true));while(t.children.length>60)t.removeChild(t.lastChild);
  if(!S.daily)return;
  if(S.names.indexOf(e.name)<0){S.names.push(e.name);S.totals[e.name]=0}
  S.totals[e.name]=(S.totals[e.name]||0)+1;
  var d=S.daily[0];if(d&&d.day===e.day){d.counts[e.name]=(d.counts[e.name]||0)+1;var cell=document.querySelector('#daily tr[data-day="'+e.day+'"] td[data-c="'+e.name+'"]');if(cell){cell.textContent=d.counts[e.name];cell.classList.remove('z');bump(cell)}else if(S.names.indexOf(e.name)>=9){}else render()}
  if(e.name==='pageview'&&d&&d.day===e.day){S.today.pageviews++;var el=$('#t_today_pv');el.textContent=n(S.today.pageviews);bump(el)}
}
var esSite=null;function connect(){if(es&&esSite===site)return;if(es)es.close();esSite=site;es=new EventSource(BASE+'/stream?site='+encodeURIComponent(site));es.onopen=function(){$('#dot').classList.add('on')};es.onerror=function(){$('#dot').classList.remove('on')};es.onmessage=function(m){try{onEvent(JSON.parse(m.data))}catch(e){}}}
$('#site').onchange=function(){site=this.value;history.replaceState(null,'','?site='+encodeURIComponent(site));load()};
$('#days').onchange=load;
loadSites().then(load);
setInterval(function(){if(document.visibilityState==='visible')load()},60000);
</script></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
