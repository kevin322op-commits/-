/* 小帳本 — 記帳＋台股持股（資料存在本機瀏覽器） */
"use strict";

/* ---------- 純計算函式（可單獨測試） ---------- */
const TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

function toNum(v){
  if(v===null||v===undefined) return NaN;
  const n = Number(String(v).replace(/[,\s]/g,""));
  return isFinite(n) ? n : NaN;
}
// 民國日期 "1151103" 或 "115/11/03" → "2026-11-03"
function rocToIso(s){
  if(!s) return "";
  const t = String(s).replace(/\D/g,"");
  if(t.length===7){ return (Number(t.slice(0,3))+1911)+"-"+t.slice(3,5)+"-"+t.slice(5,7); }
  if(t.length===8){ return t.slice(0,4)+"-"+t.slice(4,6)+"-"+t.slice(6,8); }
  return "";
}
// 把證交所／櫃買的資料整理成 {代號:{name,close,date}}
function parseQuotes(rows){
  const out = {};
  if(!Array.isArray(rows)) return out;
  rows.forEach(r=>{
    const code = String(r.Code ?? r.SecuritiesCompanyCode ?? "").trim();
    const name = String(r.Name ?? r.CompanyName ?? "").trim();
    const close = toNum(r.ClosingPrice ?? r.Close);
    if(!code || !(close>0)) return;
    out[code] = {name, close, date: rocToIso(r.Date)};
  });
  return out;
}
function summarizeMonth(list){
  let I=0,O=0,S=0; const byCat={};
  list.forEach(e=>{
    if(e.type==="in") I+=e.amount;
    else if(e.type==="out"){ O+=e.amount; byCat[e.cat]=(byCat[e.cat]||0)+e.amount; }
    else if(e.type==="save") S+=e.amount;
  });
  return {I,O,S,left:I-O-S,rate:I>0?S/I:null,byCat};
}
function valueHolding(h, quote){
  const price = h.manualPrice>0 ? h.manualPrice : (quote && quote.close>0 ? quote.close : null);
  const cost = h.shares*h.cost;
  if(price===null) return {price:null,cost,mv:null,pl:null,pct:null};
  const mv = h.shares*price;
  return {price,cost,mv,pl:mv-cost,pct:cost>0?(mv-cost)/cost:null};
}

if(typeof module!=="undefined"){ module.exports={toNum,rocToIso,parseQuotes,summarizeMonth,valueHolding}; }

/* ---------- 介面 ---------- */
if(typeof document!=="undefined") (function(){
  const CATS = {
    out:["餐飲","交通","購物","居住","娛樂","醫療","學習","其他"],
    in:["薪水","打工接案","獎金","投資收益","其他"],
    save:["儲蓄","定期定額","股票ETF","緊急預備金"]
  };
  const TYPE_NAME = {out:"支出",in:"收入",save:"存起來"};
  const KEY = {entries:"xzb.entries.v1", holdings:"xzb.holdings.v1", quotes:"xzb.quotes.v1"};

  const load=(k,d)=>{ try{ const r=localStorage.getItem(k); return r?JSON.parse(r):d; }catch(e){ return d; } };
  const save=(k,v)=>{ try{ localStorage.setItem(k,JSON.stringify(v)); return true; }catch(e){ return false; } };

  let entries = load(KEY.entries, []);
  let holdings = load(KEY.holdings, []);   // {id,code,shares,cost,manualPrice?}
  let quotes = load(KEY.quotes, {map:{},date:"",fetchedAt:0}); // map: {code:{name,close,date}}
  let sample = null;   // 範例模式時暫存真實資料

  const $ = id => document.getElementById(id);
  const fmt = n => Math.round(n).toLocaleString("zh-TW");
  const fmt2 = n => Number(n).toLocaleString("zh-TW",{maximumFractionDigits:2});
  const pad = n => String(n).padStart(2,"0");
  const ymd = d => d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());
  const uid = p => p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const signed = n => (n>0?"+":n<0?"−":"")+fmt(Math.abs(n));

  /* ===== 分頁 ===== */
  const views = ["ledger","stocks","backup"];
  function show(v){
    if(!views.includes(v)) v="ledger";
    views.forEach(x=>{ $("view-"+x).hidden = x!==v; });
    document.querySelectorAll("nav.tabs button").forEach(b=>{
      if(b.dataset.view===v) b.setAttribute("aria-current","page"); else b.removeAttribute("aria-current");
    });
    if(v==="stocks"){ renderStocks(); maybeAutoRefresh(); }
    if(v==="backup") renderBackup();
    window.scrollTo(0,0);
  }
  document.querySelectorAll("nav.tabs button").forEach(b=>b.onclick=()=>{ history.replaceState(null,"","#"+b.dataset.view); show(b.dataset.view); });

  /* ===== 記帳 ===== */
  let type="out", cat=CATS.out[0];
  const today=new Date();
  let viewY=today.getFullYear(), viewM=today.getMonth();
  let pendingDelete=null;
  $("date").value=ymd(today);

  function renderChips(){
    $("chips").innerHTML="";
    CATS[type].forEach(c=>{
      const b=document.createElement("button");b.type="button";b.textContent=c;
      b.setAttribute("aria-pressed",c===cat?"true":"false");
      b.onclick=()=>{cat=c;renderChips();};
      $("chips").appendChild(b);
    });
  }
  document.querySelectorAll(".seg button").forEach(b=>{
    b.onclick=()=>{
      type=b.dataset.t; cat=CATS[type][0];
      document.querySelectorAll(".seg button").forEach(x=>x.setAttribute("aria-pressed",x===b?"true":"false"));
      renderChips();
    };
  });
  $("prev").onclick=()=>{ viewM--; if(viewM<0){viewM=11;viewY--;} renderLedger(); };
  $("next").onclick=()=>{ viewM++; if(viewM>11){viewM=0;viewY++;} renderLedger(); };

  function renderLedger(){
    $("sampleBar").hidden = !sample;
    $("monthLabel").textContent = viewY+" 年 "+(viewM+1)+" 月";
    const p=viewY+"-"+pad(viewM+1);
    const list=entries.filter(e=>e.date && e.date.slice(0,7)===p);
    const s=summarizeMonth(list);
    $("left").textContent=(s.left<0?"−":"")+"NT$ "+fmt(Math.abs(s.left));
    $("left").style.color=s.left<0?"var(--out)":"var(--ink)";
    $("sumIn").textContent=fmt(s.I); $("sumOut").textContent=fmt(s.O); $("sumSave").textContent=fmt(s.S);
    if(s.rate!==null){
      const r=s.rate*100;
      $("rateText").textContent=r.toFixed(0)+"%";
      $("rateBar").style.width=Math.min(r,100)+"%";
      $("rateHint").textContent = r>=20 ? "很好，這個月存下的比例已達 20% 參考線。"
        : s.S>0 ? "已經開始存了。可以試著領薪水當天先撥一筆出來，再花剩下的。"
        : "這個月還沒有「存起來」的紀錄。先從收入的 5–10% 開始也很好。";
    } else {
      $("rateText").textContent="—"; $("rateBar").style.width="0%";
      $("rateHint").textContent="記下收入後，這裡會顯示你存下了收入的幾成。灰線是常見的 20% 參考目標。";
    }

    const cats=$("cats"); cats.innerHTML="";
    const sorted=Object.entries(s.byCat).sort((a,b)=>b[1]-a[1]);
    if(!sorted.length) cats.innerHTML='<div class="empty">這個月還沒有支出紀錄。</div>';
    sorted.forEach(([c,v])=>{
      const d=document.createElement("div");d.className="cat";
      d.innerHTML='<span></span><div class="bar"><i></i></div><span class="num"></span>';
      d.children[0].textContent=c;
      d.querySelector("i").style.width=(v/sorted[0][1]*100)+"%";
      d.children[2].textContent=fmt(v)+"（"+Math.round(v/s.O*100)+"%）";
      cats.appendChild(d);
    });

    const box=$("list"); box.innerHTML="";
    if(!list.length){
      const e=document.createElement("div");e.className="empty";
      e.innerHTML="<span>這個月還沒有紀錄。在上面輸入金額、選分類，按「記下來」就完成第一筆。</span>";
      if(!sample && entries.length===0){
        const b=document.createElement("button");b.className="link";b.textContent="先看看範例長什麼樣子";
        b.onclick=enterSample; e.appendChild(b);
      }
      box.appendChild(e); return;
    }
    const days={};
    list.slice().sort((a,b)=>b.date.localeCompare(a.date)||(b.createdAt||0)-(a.createdAt||0))
      .forEach(e=>{(days[e.date]=days[e.date]||[]).push(e);});
    const wk="日一二三四五六";
    Object.keys(days).forEach(d=>{
      const g=document.createElement("div");g.className="day";
      const dt=new Date(d+"T00:00:00");
      let spent=0; days[d].forEach(e=>{ if(e.type==="out") spent+=e.amount; });
      const h=document.createElement("div");h.className="day-h";
      h.innerHTML='<span></span><span class="num"></span>';
      h.children[0].textContent=(dt.getMonth()+1)+"/"+dt.getDate()+"（"+wk[dt.getDay()]+"）";
      h.children[1].textContent=spent?"支出 "+fmt(spent):"";
      g.appendChild(h);
      days[d].forEach(e=>{
        const it=document.createElement("div");it.className="item";
        it.innerHTML='<span class="tag '+e.type+'"></span><span class="note"></span><span class="amt"></span><button class="del" type="button">刪除</button>';
        it.children[0].textContent=e.cat;
        it.children[1].textContent=e.note||TYPE_NAME[e.type];
        if(e.note){ const sm=document.createElement("small"); sm.textContent=TYPE_NAME[e.type]; it.children[1].appendChild(sm); }
        const a=it.children[2]; a.textContent=(e.type==="in"?"+":"−")+fmt2(e.amount);
        a.style.color= e.type==="in"?"var(--in)":e.type==="save"?"var(--save)":"var(--ink)";
        const del=it.children[3];
        if(pendingDelete===e.id){ del.classList.add("confirm"); del.textContent="確定刪除"; }
        del.onclick=()=>{
          if(pendingDelete===e.id){ pendingDelete=null; entries=entries.filter(x=>x.id!==e.id); persistEntries(); renderLedger(); }
          else { pendingDelete=e.id; renderLedger(); setTimeout(()=>{ if(pendingDelete===e.id){ pendingDelete=null; renderLedger(); } },4000); }
        };
        g.appendChild(it);
      });
      box.appendChild(g);
    });
  }
  function persistEntries(){ if(!sample) save(KEY.entries,entries); }

  function enterSample(){
    sample={entries};
    const y=viewY, m=pad(viewM+1), d=n=>y+"-"+m+"-"+pad(n);
    entries=[
      {type:"in",amount:38000,cat:"薪水",note:"薪資入帳",date:d(1)},
      {type:"save",amount:5000,cat:"定期定額",note:"台股 ETF 定期定額",date:d(1)},
      {type:"save",amount:3000,cat:"緊急預備金",note:"",date:d(1)},
      {type:"out",amount:12000,cat:"居住",note:"房租",date:d(2)},
      {type:"out",amount:120,cat:"餐飲",note:"早餐",date:d(3)},
      {type:"out",amount:1200,cat:"交通",note:"通勤月票",date:d(3)},
      {type:"out",amount:890,cat:"購物",note:"日用品",date:d(4)},
      {type:"out",amount:260,cat:"餐飲",note:"午餐",date:d(4)},
      {type:"out",amount:450,cat:"娛樂",note:"電影",date:d(4)},
      {type:"in",amount:3000,cat:"打工接案",note:"翻譯案",date:d(4)}
    ].map((e,i)=>({...e,id:uid("s"),createdAt:i}));
    renderLedger();
  }
  $("exitSample").onclick=()=>{ entries=sample.entries; sample=null; renderLedger(); };

  $("form").addEventListener("submit",ev=>{
    ev.preventDefault();
    const amt=toNum($("amount").value);
    if(!(amt>0)){ $("err").textContent="請輸入大於 0 的金額，例如 120。"; $("err").hidden=false; $("amount").focus(); return; }
    if(!$("date").value){ $("err").textContent="請選一個日期。"; $("err").hidden=false; return; }
    $("err").hidden=true;
    const e={id:uid("e"),type,amount:Math.round(amt*100)/100,cat,note:$("note").value.trim(),date:$("date").value,createdAt:Date.now()};
    const [y,m]=e.date.split("-").map(Number); viewY=y; viewM=m-1;
    entries.push(e); persistEntries(); renderLedger();
    $("amount").value=""; $("note").value=""; $("amount").focus();
  });

  /* ===== 持股 ===== */
  let editing=null, pendingHoldDel=null, fetching=false;

  async function getJson(url){
    const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),15000);
    try{ const r=await fetch(url,{signal:ctl.signal,cache:"no-store"}); if(!r.ok) throw new Error("HTTP "+r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  }
  async function refreshQuotes(){
    if(fetching) return; fetching=true;
    $("refresh").disabled=true; $("refresh").textContent="更新中…";
    const [a,b]=await Promise.allSettled([getJson(TWSE_URL),getJson(TPEX_URL)]);
    const map={};
    let latest="";
    [a,b].forEach(r=>{ if(r.status==="fulfilled"){ const q=parseQuotes(r.value); Object.assign(map,q); Object.values(q).forEach(v=>{ if(v.date>latest) latest=v.date; }); } });
    fetching=false; $("refresh").disabled=false; $("refresh").textContent="更新股價";
    const errBox=$("priceErr");
    if(Object.keys(map).length){
      quotes={map,date:latest,fetchedAt:Date.now()}; save(KEY.quotes,quotes);
      const miss=[]; if(a.status!=="fulfilled") miss.push("上市"); if(b.status!=="fulfilled") miss.push("上櫃");
      if(miss.length){ errBox.textContent="這次讀不到"+miss.join("、")+"股票的資料，那部分會沿用手動填的價格。"; errBox.hidden=false; }
      else errBox.hidden=true;
    } else {
      errBox.textContent="目前讀不到證交所與櫃買中心的資料，可能是網路不穩，或對方暫時不開放這種讀取方式。可以點每檔的股價手動填入最新收盤價，損益一樣會算。";
      errBox.hidden=false;
    }
    renderStocks();
  }
  function maybeAutoRefresh(){
    if(!holdings.length) return;
    if(Date.now()-(quotes.fetchedAt||0) > 60*60*1000) refreshQuotes();
  }
  $("refresh").onclick=refreshQuotes;

  $("hCode").addEventListener("input",()=>{
    const c=$("hCode").value.trim().toUpperCase();
    const q=quotes.map[c];
    $("hName").textContent = q ? q.name+"，最近收盤 "+fmt2(q.close)+" 元" : "";
  });

  $("hForm").addEventListener("submit",ev=>{
    ev.preventDefault();
    const code=$("hCode").value.trim().toUpperCase();
    const shares=toNum($("hShares").value);
    const cost=toNum($("hCost").value);
    const err=$("hErr");
    if(!/^[0-9A-Z]{4,6}$/.test(code)){ err.textContent="請輸入 4–6 碼的股票代號，例如 2330 或 0050。"; err.hidden=false; return; }
    if(!(shares>0)){ err.textContent="請輸入股數。1 張是 1000 股，零股就填實際股數。"; err.hidden=false; return; }
    if(!(cost>0)){ err.textContent="請輸入每股的平均買進價格。"; err.hidden=false; return; }
    err.hidden=true;
    const exist=holdings.find(h=>h.code===code);
    if(exist){ // 加碼：合併為加權平均成本
      const tot=exist.shares+shares;
      exist.cost=Math.round(((exist.shares*exist.cost+shares*cost)/tot)*100)/100;
      exist.shares=tot;
    } else holdings.push({id:uid("h"),code,shares,cost});
    save(KEY.holdings,holdings);
    $("hCode").value=""; $("hShares").value=""; $("hCost").value=""; $("hName").textContent="";
    renderStocks();
    if(!quotes.map[code] && !fetching) refreshQuotes();
  });

  function renderStocks(){
    let mv=0,cost=0,priced=true;
    const box=$("holdList"); box.innerHTML="";
    if(!holdings.length){
      box.innerHTML='<div class="empty">還沒有持股。在上面輸入代號、股數和買進價格就能加入。</div>';
    }
    holdings.forEach(h=>{
      const q=quotes.map[h.code];
      const v=valueHolding(h,q);
      cost+=v.cost; if(v.mv===null) priced=false; else mv+=v.mv;
      const d=document.createElement("div");d.className="hold";
      const nm=document.createElement("div");nm.className="nm";
      nm.innerHTML="<small></small><span></span>";
      nm.children[0].textContent=h.code; nm.children[1].textContent=q?q.name:"";
      const mvEl=document.createElement("div");mvEl.className="mv";
      mvEl.textContent=v.mv===null?"—":fmt(v.mv);
      const sub=document.createElement("div");sub.className="sub";
      const sh=document.createElement("span");
      sh.textContent=(h.shares>=1000&&h.shares%1000===0?(h.shares/1000)+" 張":fmt(h.shares)+" 股")+"・成本 "+fmt2(h.cost)+"・現價";
      sub.appendChild(sh);
      if(editing===h.id){
        const w=document.createElement("span");w.className="price-edit";
        w.innerHTML='<input class="field num" inputmode="decimal" aria-label="手動輸入股價"><button class="ghost" type="button">好</button>';
        const inp=w.children[0]; inp.value=v.price??"";
        const done=()=>{ const n=toNum(inp.value); if(n>0) h.manualPrice=n; else delete h.manualPrice; editing=null; save(KEY.holdings,holdings); renderStocks(); };
        w.children[1].onclick=done; inp.onkeydown=e=>{ if(e.key==="Enter"){e.preventDefault();done();} };
        sub.appendChild(w); setTimeout(()=>inp.focus(),0);
      } else {
        const pb=document.createElement("button");pb.type="button";pb.className="price-btn";
        pb.textContent=v.price===null?"填入":fmt2(v.price);
        pb.onclick=()=>{ editing=h.id; renderStocks(); };
        sub.appendChild(pb);
        if(h.manualPrice>0){ const pl=document.createElement("span");pl.className="pill";pl.textContent="手動"; sub.appendChild(pl); }
      }
      const plEl=document.createElement("div");plEl.className="pl";
      if(v.pl!==null){
        plEl.textContent=signed(v.pl)+"（"+(v.pct*100>=0?"+":"")+(v.pct*100).toFixed(1)+"%）";
        plEl.className="pl "+(v.pl>0?"up":v.pl<0?"down":"");
      }
      const acts=document.createElement("div");acts.className="acts";
      if(h.manualPrice>0 && q){ const r=document.createElement("button");r.type="button";r.className="del";r.textContent="改回收盤價";r.onclick=()=>{delete h.manualPrice;save(KEY.holdings,holdings);renderStocks();}; acts.appendChild(r); }
      const del=document.createElement("button");del.type="button";del.className="del";
      if(pendingHoldDel===h.id){ del.classList.add("confirm"); del.textContent="確定移除"; } else del.textContent="移除";
      del.onclick=()=>{
        if(pendingHoldDel===h.id){ pendingHoldDel=null; holdings=holdings.filter(x=>x.id!==h.id); save(KEY.holdings,holdings); renderStocks(); }
        else { pendingHoldDel=h.id; renderStocks(); setTimeout(()=>{ if(pendingHoldDel===h.id){ pendingHoldDel=null; renderStocks(); } },4000); }
      };
      acts.appendChild(del);
      d.append(nm,mvEl,sub,plEl,acts);
      box.appendChild(d);
    });
    $("mvTotal").textContent = (!priced && mv===0) ? "NT$ —" : "NT$ "+fmt(mv)+(priced?"":"＋");
    $("costTotal").textContent=fmt(cost);
    if(holdings.length && priced){
      const pl=mv-cost;
      $("plTotal").textContent=signed(pl); $("plTotal").className="v "+(pl>0?"up":pl<0?"down":"");
      $("plPct").textContent=cost>0?((pl/cost*100>=0?"+":"")+(pl/cost*100).toFixed(1)+"%"):"—"; $("plPct").className="v "+(pl>0?"up":pl<0?"down":"");
    } else {
      $("plTotal").textContent=holdings.length?"有股票缺價格":"0"; $("plTotal").className="v";
      $("plPct").textContent="—"; $("plPct").className="v";
    }
    if(quotes.fetchedAt){
      const [y,m,dd]=(quotes.date||"").split("-");
      $("priceInfo").textContent=(quotes.date?Number(m)+"/"+Number(dd)+" 收盤價":"已更新")+"・更新於 "+new Date(quotes.fetchedAt).toLocaleString("zh-TW",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
    } else $("priceInfo").textContent="尚未取得股價";
  }

  /* ===== 備份 ===== */
  function backupObj(){ return {app:"小帳本",version:1,exportedAt:new Date().toISOString(),entries:sample?sample.entries:entries,holdings}; }
  function renderBackup(){
    const b=backupObj();
    $("counts").textContent="目前有 "+b.entries.length+" 筆記帳、"+holdings.length+" 檔持股。";
    $("exportText").value=JSON.stringify(b);
  }
  $("exportBtn").onclick=()=>{
    const blob=new Blob([JSON.stringify(backupObj(),null,1)],{type:"application/json"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download="小帳本備份-"+ymd(new Date())+".json";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    $("exportMsg").textContent="備份檔已下載。"; $("exportMsg").hidden=false;
  };
  $("copyBtn").onclick=async()=>{
    const t=$("exportText");
    try{ await navigator.clipboard.writeText(t.value); $("exportMsg").textContent="已複製，可以貼到記事本或傳給自己保存。"; }
    catch(e){ t.focus(); t.select(); $("exportMsg").textContent="已選取文字，請按「複製」。"; }
    $("exportMsg").hidden=false;
  };
  $("importFile").onchange=()=>{
    const f=$("importFile").files[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{ $("importText").value=r.result; }; r.readAsText(f);
  };
  let importArmed=false;
  $("importBtn").onclick=()=>{
    const err=$("importErr"), ok=$("importMsg"); err.hidden=true; ok.hidden=true;
    let data;
    try{ data=JSON.parse($("importText").value); }catch(e){ err.textContent="看不懂這份備份，請確認是從小帳本匯出的完整內容。"; err.hidden=false; return; }
    if(!data || !Array.isArray(data.entries) || !Array.isArray(data.holdings)){ err.textContent="這份資料缺少記帳或持股內容，請確認是小帳本的備份檔。"; err.hidden=false; return; }
    if(!importArmed){ importArmed=true; $("importBtn").classList.add("armed"); $("importBtn").textContent="再按一次確定還原（會取代目前資料）"; setTimeout(()=>{ importArmed=false; $("importBtn").classList.remove("armed"); $("importBtn").textContent="還原"; },5000); return; }
    importArmed=false; $("importBtn").classList.remove("armed"); $("importBtn").textContent="還原";
    sample=null;
    entries=data.entries.filter(e=>e&&e.type&&e.date&&toNum(e.amount)>0).map(e=>({...e,amount:toNum(e.amount)}));
    holdings=data.holdings.filter(h=>h&&h.code&&toNum(h.shares)>0).map(h=>({...h,shares:toNum(h.shares),cost:toNum(h.cost)}));
    save(KEY.entries,entries); save(KEY.holdings,holdings);
    ok.textContent="已還原 "+entries.length+" 筆記帳、"+holdings.length+" 檔持股。"; ok.hidden=false;
    renderLedger(); renderBackup();
  };
  let wipeArmed=false;
  $("wipeBtn").onclick=()=>{
    const b=$("wipeBtn");
    if(!wipeArmed){ wipeArmed=true; b.classList.add("armed"); b.textContent="再按一次確定清除"; setTimeout(()=>{ wipeArmed=false; b.classList.remove("armed"); b.textContent="清除所有資料"; },5000); return; }
    wipeArmed=false; b.classList.remove("armed"); b.textContent="清除所有資料";
    entries=[]; holdings=[]; sample=null; quotes={map:{},date:"",fetchedAt:0};
    Object.values(KEY).forEach(k=>{ try{ localStorage.removeItem(k); }catch(e){} });
    renderLedger(); renderStocks(); renderBackup();
  };

  /* ===== 啟動 ===== */
  renderChips(); renderLedger(); renderStocks();
  show((location.hash||"").slice(1));
  if("serviceWorker" in navigator && location.protocol==="https:"){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
  // 請瀏覽器盡量保留資料，不要自動清除
  if(navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(()=>{});
})();
