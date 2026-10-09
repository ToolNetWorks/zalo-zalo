const $ = id => document.getElementById(id);
const screens = ['platform','login','dashboard','recovery'];
let timer, friends = [], dashboardLoaded = false, selected = null;
function show(id) { screens.forEach(x => $(x).hidden = x !== id); }
function image(id,url) {
  const el=$(id);const valid=typeof url==='string' && /^https:\/\//.test(url);
  el.hidden=!valid;if(valid) el.src=url;else el.removeAttribute('src');
}
async function json(url,opts) {
  const r=await fetch(url,{cache:'no-store',...opts});const d=await r.json();
  if(!r.ok)throw new Error(d.error||`HTTP ${r.status}`);return d;
}
async function startQR() {
  try { await json('/api/qr/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});await poll(); }
  catch(e) {$('qr-status').textContent='Không tạo được QR: '+e.message;}
}
const statuses={IDLE:'Chưa tạo QR',QR_PENDING:'Đang tạo QR từ Zalo...',QR_READY:'Quét QR bằng Zalo',QR_SCANNED:'Đã quét, hãy xác nhận trên Zalo',WAITING_CONFIRMATION:'Đang xác nhận đăng nhập',AUTHENTICATED:'Đăng nhập thành công',QR_EXPIRED:'QR hết hạn, bấm tạo lại',QR_DECLINED:'Đã từ chối, bấm thử lại',AUTH_FAILED:'Đăng nhập thất bại, bấm thử lại'};
async function poll() {
  try {
    const d=await json('/api/qr/status');
    if(d.authenticated){ clearInterval(timer);show('dashboard');await loadDashboard();return; }
    $('qr-status').textContent=statuses[d.status]||d.status;
    const qr=d.qrImage;
    $('real-qr').hidden=!qr;
    if(qr)$('real-qr').src=qr;else $('real-qr').removeAttribute('src');
    $('qr-message').textContent='Đang xác thực tài khoản Zalo';
    $('check').textContent=['QR_EXPIRED','QR_DECLINED','AUTH_FAILED'].includes(d.status)?'Tạo lại QR':'Kiểm tra / tạo QR';
  }catch(e){$('qr-status').textContent='Lỗi kết nối: '+e.message;}
}
async function loadDashboard() {
  if(dashboardLoaded)return;
  dashboardLoaded=true;
  const profileTask=json('/api/zalo/profile').then(({profile:p})=>{
    $('me-name').textContent=p.name;
    $('me-id').textContent=p.id||'Không có';
    $('me-username').textContent=p.username||p.zaloName||'Không có';
    $('me-phone').textContent=p.phone||'Không được cung cấp';
    $('me-sub').textContent='Tài khoản Zalo đã xác thực';
    image('me-avatar',p.avatar);
  }).catch(e=>{$('me-name').textContent='Không tải được hồ sơ';$('me-sub').textContent=e.message;});
  const friendsTask=json('/api/zalo/contacts').then(({contacts,total})=>{
    friends=contacts;
    $('friends-count').textContent=String(total);
    renderFriends();
    loadFrequent();
  }).catch(e=>{$('friends-count').textContent='Không khả dụng';$('friends-status').textContent='Không tải được danh bạ: '+e.message;dashboardLoaded=false;});
  await Promise.all([profileTask,friendsTask]);
}

// RECOVERY_ACTIVITY_V1 frontend.
let frequentPoll = null;
async function loadFrequent() {
  try {
    const data = await json('/api/zalo/frequent');
    const status = {
      NOT_STARTED:'Chưa đồng bộ; bấm nút để thử lấy lịch sử Zalo.',
      CONNECTING:'Đang kết nối Zalo...',
      SYNCING:'Đang yêu cầu lịch sử tin nhắn từ Zalo...',
      READY:'Đã phân tích dữ liệu tin nhắn truy cập được.',
      LIVE_ONLY:'Không nhận được lịch sử cũ; đang ghi nhận tin nhắn mới.',
      ERROR:'Đồng bộ gặp lỗi.',
      DISCONNECTED:'Đã mất kết nối; giữ số liệu trước đó.'
    };
    $('sync-frequent').disabled = ['CONNECTING','SYNCING','READY','LIVE_ONLY'].includes(data.status);
    $('frequent-status').textContent = (status[data.status]||data.status)
      + ' Tổng tin đã ghi nhận: '+data.sampledMessages+'.'
      + (data.error?' '+data.error:'');
    const list=$('frequent-list');list.replaceChildren();
    if (!data.contacts.length) {
      const p=document.createElement('p');p.className='muted';
      p.textContent='Chưa đủ dữ liệu để xếp hạng. Không sử dụng danh bạ mẫu.';
      list.append(p);
    }
    for (const [index,item] of data.contacts.entries()) {
      const btn=document.createElement('button');btn.className='person';btn.type='button';
      const num=document.createElement('b');num.textContent=String(index+1)+'.';
      const avatar=document.createElement('img');avatar.className='photo';avatar.alt='';
      if (item.avatar) avatar.src=item.avatar; else avatar.hidden=true;
      const summary=document.createElement('span');summary.textContent=item.name;
      const sub=document.createElement('small');
      sub.textContent=item.count+' tin đã ghi nhận'+(item.last?' · Gần nhất '+new Date(item.last).toLocaleDateString('vi-VN'):'');
      summary.append(sub);
      btn.append(num,avatar,summary);
      btn.onclick=()=>{
        const friend=friends.find(x=>x.id===item.id);
        if(friend) selectFriend(friend);
      };
      list.append(btn);
    }
  } catch(error) {
    $('frequent-status').textContent='Không tải được thống kê: '+error.message;
  }
}
$('sync-frequent').onclick=async()=>{
  $('sync-frequent').disabled=true;
  try {
    await json('/api/zalo/frequent/sync',{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'
    });
    await loadFrequent();
    clearInterval(frequentPoll);
    frequentPoll=setInterval(()=>{
      if (!$('dashboard').hidden) loadFrequent();
    },4000);
  } catch(e) {
    $('frequent-status').textContent='Lỗi đồng bộ: '+e.message;
    $('sync-frequent').disabled=false;
  }
};

function renderFriends() {
  const query=$('search').value.toLocaleLowerCase('vi').trim();
  const matches=friends.filter(f=>(f.name+' '+f.zaloName+' '+f.username).toLocaleLowerCase('vi').includes(query));
  $('friends-status').textContent=`${matches.length} / ${friends.length} liên hệ. Hiển thị tối đa 80; dùng ô tìm kiếm để lọc.`;
  const list=$('friends');list.replaceChildren();
  for(const f of matches.slice(0,80)){
    const b=document.createElement('button');b.className='person';b.type='button';
    const avatar=document.createElement('img');avatar.className='photo';avatar.alt='';
    if(f.avatar)avatar.src=f.avatar;else avatar.hidden=true;
    const span=document.createElement('span');span.textContent=f.name;
    const sub=document.createElement('small');sub.textContent=f.username||'Bạn bè Zalo';span.append(sub);
    const arrow=document.createElement('strong');arrow.textContent='→';
    b.append(avatar,span,arrow);b.onclick=()=>selectFriend(f);list.append(b);
  }
}
function selectFriend(friend) {
  selected=friend;
  $('selected-name').textContent=friend.name;
  $('selected-id').textContent='Zalo ID: '+friend.id;
  $('recovery-note').hidden=true;
  image('selected-avatar',friend.avatar);
  show('recovery');
}
$('choose-zalo').onclick=async()=>{
  show('login');
  try {
    const d=await json('/api/qr/status');
    if(d.authenticated){show('dashboard');await loadDashboard();return;}
    if(['IDLE','AUTH_FAILED','QR_EXPIRED','QR_DECLINED'].includes(d.status))await startQR();
    else await poll();
    clearInterval(timer);timer=setInterval(poll,1500);
  }catch(e){$('qr-status').textContent='Không kết nối được backend: '+e.message;}
};
$('check').onclick=startQR;
$('back-login').onclick=()=>{clearInterval(timer);show('platform');};
$('back-dashboard').onclick=()=>show('platform');
$('back-recovery').onclick=()=>show('dashboard');
$('start-recovery').onclick=()=>{$('recovery-note').hidden=false;};
$('search').oninput=renderFriends;
show('platform');