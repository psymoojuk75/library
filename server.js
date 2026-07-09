const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, 'library.db'));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json({limit:'5mb'}));
app.use(express.static(path.join(__dirname,'public')));

function hash(pw){ return crypto.createHash('sha256').update(String(pw)).digest('hex'); }
function today(){ return new Date().toISOString().slice(0,10); }
function addDays(dateStr, days){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+Number(days||14)); return d.toISOString().slice(0,10); }
function daysBetween(a,b){ return Math.ceil((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/86400000); }
function token(){ return crypto.randomBytes(24).toString('hex'); }
function publicUser(u){ return u?{id:u.id,name:u.name,username:u.username,role:u.role,status:u.status,suspended_until:u.suspended_until,suspended_reason:u.suspended_reason}:null; }

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,username TEXT NOT NULL UNIQUE,password TEXT NOT NULL,role TEXT DEFAULT 'user',status TEXT DEFAULT 'active',suspended_until TEXT,suspended_reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS books(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,author TEXT,publisher TEXT,category TEXT,location TEXT,isbn TEXT,call_no TEXT,memo TEXT,cover TEXT,status TEXT DEFAULT 'available',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS loans(id INTEGER PRIMARY KEY AUTOINCREMENT,book_id INTEGER NOT NULL,user_id INTEGER NOT NULL,loan_date TEXT NOT NULL,due_date TEXT NOT NULL,return_date TEXT,renew_count INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY AUTOINCREMENT,book_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT DEFAULT 'waiting',created_at TEXT DEFAULT CURRENT_TIMESTAMP,fulfilled_at TEXT,cancelled_at TEXT);
CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,content TEXT NOT NULL,pinned INTEGER DEFAULT 0,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id INTEGER,action TEXT NOT NULL,target TEXT,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);
for(const [k,v] of Object.entries({loan_days:'14',max_loans:'5',renew_days:'7',library_name:'민코주 서울급 도서관'})) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k,v);
db.prepare('INSERT OR IGNORE INTO users(name,username,password,role) VALUES(?,?,?,?)').run('관리자','admin',hash('1234'),'admin');

// v7 확장 테이블: 서울도서관급 운영 메뉴
 db.exec(`
CREATE TABLE IF NOT EXISTS reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,book_id INTEGER,user_id INTEGER,rating INTEGER DEFAULT 5,content TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS wishlists(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,book_id INTEGER,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,book_id));
CREATE TABLE IF NOT EXISTS reading_goals(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,month TEXT,target INTEGER DEFAULT 5,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(user_id,month));
CREATE TABLE IF NOT EXISTS book_reports(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,book_id INTEGER,title TEXT,content TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS library_events(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,content TEXT,event_date TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS book_status_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,book_id INTEGER,status TEXT,detail TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS purchase_requests(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,title TEXT,author TEXT,reason TEXT,status TEXT DEFAULT '검토중',created_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);


function setting(k){ return db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value; }
function log(actor,action,target,detail){ db.prepare('INSERT INTO audit(actor_id,action,target,detail) VALUES(?,?,?,?)').run(actor?.id||null,action,target||'',detail||''); }
function auth(req,res,next){ const t=(req.headers.authorization||'').replace('Bearer ',''); const row=t&&db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?').get(t); if(!row) return res.status(401).json({error:'로그인이 필요합니다.'}); req.user=row; next(); }
function admin(req,res,next){ if(req.user.role!=='admin') return res.status(403).json({error:'관리자만 가능합니다.'}); next(); }
function active(req,res,next){ if(req.user.status==='suspended' && req.user.suspended_until && req.user.suspended_until>=today()) return res.status(403).json({error:`대출정지 상태입니다. ${req.user.suspended_until}까지`, reason:req.user.suspended_reason}); next(); }
function bookWithState(b){ const loan=db.prepare('SELECT l.*,u.name user_name FROM loans l JOIN users u ON u.id=l.user_id WHERE l.book_id=? AND l.return_date IS NULL ORDER BY l.id DESC LIMIT 1').get(b.id); const reserve=db.prepare("SELECT COUNT(*) cnt FROM reservations WHERE book_id=? AND status='waiting'").get(b.id).cnt; return {...b,current_loan:loan||null,reservation_count:reserve,status:loan?'loaned':b.status}; }

app.post('/api/register',(req,res)=>{ const {name,username,password}=req.body; if(!name||!username||!password) return res.status(400).json({error:'이름, 아이디, 비밀번호를 입력하세요.'}); try{ const info=db.prepare('INSERT INTO users(name,username,password) VALUES(?,?,?)').run(name,username,hash(password)); log({id:info.lastInsertRowid},'REGISTER','user',username); res.json({ok:true}); }catch(e){ res.status(400).json({error:'이미 있는 아이디입니다.'}); } });
app.post('/api/login',(req,res)=>{ const u=db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(req.body.username,hash(req.body.password)); if(!u) return res.status(401).json({error:'아이디 또는 비밀번호가 틀렸습니다.'}); const t=token(); db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(t,u.id); res.json({token:t,user:publicUser(u)}); });
app.get('/api/me',auth,(req,res)=>res.json(publicUser(req.user)));
app.get('/api/settings',(req,res)=>res.json(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value]))));
app.put('/api/settings',auth,admin,(req,res)=>{ for(const k of ['loan_days','max_loans','renew_days','library_name']) if(req.body[k]!=null) db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k,String(req.body[k])); log(req.user,'UPDATE_SETTINGS','settings',JSON.stringify(req.body)); res.json({ok:true}); });

app.get('/api/books',(req,res)=>{ const q=(req.query.q||'').trim(); const rows=q?db.prepare(`SELECT * FROM books WHERE title LIKE ? OR author LIKE ? OR category LIKE ? OR isbn LIKE ? OR call_no LIKE ? ORDER BY id DESC`).all(...Array(5).fill('%'+q+'%')):db.prepare('SELECT * FROM books ORDER BY id DESC').all(); res.json(rows.map(bookWithState)); });
app.get('/api/books/:id',(req,res)=>{ const b=db.prepare('SELECT * FROM books WHERE id=?').get(req.params.id); if(!b) return res.status(404).json({error:'책을 찾을 수 없습니다.'}); res.json(bookWithState(b)); });
app.post('/api/books',auth,admin,(req,res)=>{ const b=req.body; const title=String(b.title||'').trim(); const author=String(b.author||'').trim(); if(!title) return res.status(400).json({error:'제목은 꼭 입력해야 합니다.'}); const info=db.prepare('INSERT INTO books(title,author,publisher,category,location,isbn,call_no,memo,cover) VALUES(?,?,?,?,?,?,?,?,?)').run(title,author,'','','','','','',''); log(req.user,'CREATE_BOOK','book',title); res.json({id:info.lastInsertRowid}); });
app.put('/api/books/:id',auth,admin,(req,res)=>{ const b=req.body; const title=String(b.title||'').trim(); const author=String(b.author||'').trim(); if(!title) return res.status(400).json({error:'제목은 꼭 입력해야 합니다.'}); db.prepare('UPDATE books SET title=?,author=? WHERE id=?').run(title,author,req.params.id); log(req.user,'UPDATE_BOOK','book',req.params.id); res.json({ok:true}); });
app.delete('/api/books/:id',auth,admin,(req,res)=>{ db.prepare('DELETE FROM books WHERE id=?').run(req.params.id); log(req.user,'DELETE_BOOK','book',req.params.id); res.json({ok:true}); });
app.get('/api/books/:id/qr',async(req,res)=>{ const url=`${req.protocol}://${req.get('host')}/?book=${req.params.id}`; res.type('png'); QRCode.toFileStream(res,url,{width:260}); });

app.get('/api/admin/books/template',auth,admin,(req,res)=>{
  const ws=XLSX.utils.aoa_to_sheet([
    ['제목','저자'],
    ['마법천자문 1','스튜디오 시리얼'],
    ['흔한남매 1','흔한남매']
  ]);
  ws['!cols']=[{wch:30},{wch:24}];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'책등록');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Disposition','attachment; filename="minkoju-book-template.xlsx"');
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/admin/books/import',auth,admin,upload.single('file'),(req,res)=>{
  if(!req.file) return res.status(400).json({error:'엑셀 파일을 선택하세요.'});
  let wb;
  try{ wb=XLSX.read(req.file.buffer,{type:'buffer'}); }
  catch(e){ return res.status(400).json({error:'엑셀 파일을 읽을 수 없습니다.'}); }
  const sheet=wb.Sheets[wb.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,defval:''});
  if(rows.length===0) return res.status(400).json({error:'엑셀에 내용이 없습니다.'});
  const first=(rows[0]||[]).map(v=>String(v).trim().toLowerCase());
  const titleIdx=first.findIndex(v=>['제목','책제목','도서명','title','book title'].includes(v));
  const authorIdx=first.findIndex(v=>['저자','작가','author','writer'].includes(v));
  const hasHeader=titleIdx>=0;
  const start=hasHeader?1:0;
  const ti=hasHeader?titleIdx:0;
  const ai=hasHeader?(authorIdx>=0?authorIdx:1):1;
  const stmt=db.prepare('INSERT INTO books(title,author,publisher,category,location,isbn,call_no,memo,cover) VALUES(?,?,?,?,?,?,?,?,?)');
  let added=0, skipped=0;
  const samples=[];
  const tx=db.transaction(()=>{
    for(let i=start;i<rows.length;i++){
      const row=rows[i]||[];
      const title=String(row[ti]||'').trim();
      const author=String(row[ai]||'').trim();
      if(!title){ skipped++; continue; }
      stmt.run(title,author,'','','','','','','');
      added++;
      if(samples.length<5) samples.push({title,author});
    }
  });
  try{ tx(); }catch(e){ return res.status(500).json({error:'등록 중 오류가 났습니다.'}); }
  log(req.user,'IMPORT_BOOKS','book',`excel added=${added}, skipped=${skipped}`);
  res.json({ok:true,added,skipped,samples});
});


app.post('/api/loans',auth,active,(req,res)=>{ const book=db.prepare('SELECT * FROM books WHERE id=?').get(req.body.book_id); if(!book) return res.status(404).json({error:'책이 없습니다.'}); if(db.prepare('SELECT id FROM loans WHERE book_id=? AND return_date IS NULL').get(book.id)) return res.status(400).json({error:'이미 대출중입니다.'}); const open=db.prepare('SELECT COUNT(*) cnt FROM loans WHERE user_id=? AND return_date IS NULL').get(req.user.id).cnt; if(open>=Number(setting('max_loans'))) return res.status(400).json({error:'대출 가능 권수를 초과했습니다.'}); const due=addDays(today(),setting('loan_days')); db.prepare('INSERT INTO loans(book_id,user_id,loan_date,due_date) VALUES(?,?,?,?)').run(book.id,req.user.id,today(),due); db.prepare("UPDATE books SET status='loaned' WHERE id=?").run(book.id); log(req.user,'LOAN','book',book.title); res.json({ok:true,due_date:due}); });
app.post('/api/loans/:id/return',auth,(req,res)=>{ const loan=db.prepare('SELECT * FROM loans WHERE id=? AND return_date IS NULL').get(req.params.id); if(!loan) return res.status(404).json({error:'대출내역이 없습니다.'}); if(req.user.role!=='admin' && req.user.id!==loan.user_id) return res.status(403).json({error:'본인 대출만 반납 가능합니다.'}); db.prepare('UPDATE loans SET return_date=? WHERE id=?').run(today(),loan.id); db.prepare("UPDATE books SET status='available' WHERE id=?").run(loan.book_id); log(req.user,'RETURN','loan',loan.id); res.json({ok:true,overdue_days:Math.max(0,daysBetween(loan.due_date,today()))}); });
app.post('/api/loans/:id/renew',auth,active,(req,res)=>{ const l=db.prepare('SELECT * FROM loans WHERE id=? AND return_date IS NULL').get(req.params.id); if(!l) return res.status(404).json({error:'대출내역이 없습니다.'}); if(l.user_id!==req.user.id && req.user.role!=='admin') return res.status(403).json({error:'권한이 없습니다.'}); if(l.renew_count>=1) return res.status(400).json({error:'연장은 1회만 가능합니다.'}); const nd=addDays(l.due_date,setting('renew_days')); db.prepare('UPDATE loans SET due_date=?, renew_count=renew_count+1 WHERE id=?').run(nd,l.id); res.json({ok:true,due_date:nd}); });
app.get('/api/my/loans',auth,(req,res)=>res.json(db.prepare('SELECT l.*,b.title,b.author,b.cover FROM loans l JOIN books b ON b.id=l.book_id WHERE l.user_id=? ORDER BY l.id DESC').all(req.user.id)));

app.post('/api/reservations',auth,active,(req,res)=>{ const exists=db.prepare("SELECT id FROM reservations WHERE book_id=? AND user_id=? AND status='waiting'").get(req.body.book_id,req.user.id); if(exists) return res.status(400).json({error:'이미 예약했습니다.'}); db.prepare('INSERT INTO reservations(book_id,user_id) VALUES(?,?)').run(req.body.book_id,req.user.id); log(req.user,'RESERVE','book',req.body.book_id); res.json({ok:true}); });
app.get('/api/my/reservations',auth,(req,res)=>res.json(db.prepare("SELECT r.*,b.title,b.author FROM reservations r JOIN books b ON b.id=r.book_id WHERE r.user_id=? ORDER BY r.id DESC").all(req.user.id)));
app.delete('/api/reservations/:id',auth,(req,res)=>{ const r=db.prepare('SELECT * FROM reservations WHERE id=?').get(req.params.id); if(!r) return res.status(404).json({error:'예약이 없습니다.'}); if(req.user.role!=='admin'&&r.user_id!==req.user.id) return res.status(403).json({error:'권한이 없습니다.'}); db.prepare("UPDATE reservations SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP WHERE id=?").run(r.id); res.json({ok:true}); });

app.get('/api/notices',(req,res)=>res.json(db.prepare('SELECT * FROM notices ORDER BY pinned DESC,id DESC').all()));
app.post('/api/notices',auth,admin,(req,res)=>{ db.prepare('INSERT INTO notices(title,content,pinned) VALUES(?,?,?)').run(req.body.title,req.body.content,req.body.pinned?1:0); log(req.user,'CREATE_NOTICE','notice',req.body.title); res.json({ok:true}); });
app.delete('/api/notices/:id',auth,admin,(req,res)=>{ db.prepare('DELETE FROM notices WHERE id=?').run(req.params.id); res.json({ok:true}); });

app.get('/api/admin/users',auth,admin,(req,res)=>res.json(db.prepare('SELECT id,name,username,role,status,suspended_until,suspended_reason,created_at FROM users ORDER BY id DESC').all()));
app.put('/api/admin/users/:id/suspend',auth,admin,(req,res)=>{ const until=req.body.until||addDays(today(),req.body.days||1); db.prepare("UPDATE users SET status='suspended',suspended_until=?,suspended_reason=? WHERE id=?").run(until,req.body.reason||'관리자 정지',req.params.id); log(req.user,'SUSPEND_USER','user',req.params.id); res.json({ok:true,until}); });
app.put('/api/admin/users/:id/activate',auth,admin,(req,res)=>{ db.prepare("UPDATE users SET status='active',suspended_until=NULL,suspended_reason=NULL WHERE id=?").run(req.params.id); res.json({ok:true}); });
app.post('/api/admin/auto-suspend',auth,admin,(req,res)=>{ const overdue=db.prepare("SELECT l.*,u.id uid FROM loans l JOIN users u ON u.id=l.user_id WHERE l.return_date IS NULL AND l.due_date < ?").all(today()); const done=[]; for(const l of overdue){ const od=daysBetween(l.due_date,today()); const until=addDays(today(),od); db.prepare("UPDATE users SET status='suspended',suspended_until=?,suspended_reason=? WHERE id=?").run(until,`연체 ${od}일로 ${od}일 정지`,l.uid); done.push({user_id:l.uid,overdue_days:od,until}); } res.json({ok:true,done}); });
app.get('/api/admin/loans',auth,admin,(req,res)=>res.json(db.prepare('SELECT l.*,b.title,u.name user_name,u.username FROM loans l JOIN books b ON b.id=l.book_id JOIN users u ON u.id=l.user_id ORDER BY l.id DESC').all()));
app.get('/api/admin/stats',auth,admin,(req,res)=>{ res.json({books:db.prepare('SELECT COUNT(*) c FROM books').get().c,users:db.prepare('SELECT COUNT(*) c FROM users').get().c,loaning:db.prepare('SELECT COUNT(*) c FROM loans WHERE return_date IS NULL').get().c,overdue:db.prepare('SELECT COUNT(*) c FROM loans WHERE return_date IS NULL AND due_date < ?').get(today()).c,popular:db.prepare('SELECT b.title,COUNT(*) cnt FROM loans l JOIN books b ON b.id=l.book_id GROUP BY b.id ORDER BY cnt DESC LIMIT 5').all(),recent:db.prepare('SELECT a.*,u.name actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 20').all()}); });
app.get('/api/admin/export',auth,admin,(req,res)=>{ const data={users:db.prepare('SELECT id,name,username,role,status,suspended_until,created_at FROM users').all(),books:db.prepare('SELECT * FROM books').all(),loans:db.prepare('SELECT * FROM loans').all(),reservations:db.prepare('SELECT * FROM reservations').all(),notices:db.prepare('SELECT * FROM notices').all(),settings:Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value]))}; res.attachment('minkoju-library-backup.json').json(data); });



// ===== v7 서울도서관급 확장 기능 =====
app.post('/api/wishlist/:book_id',auth,(req,res)=>{try{db.prepare('INSERT OR IGNORE INTO wishlists(user_id,book_id) VALUES(?,?)').run(req.user.id,req.params.book_id);res.json({ok:true});}catch(e){res.status(400).json({error:'찜하기 실패'});}});
app.delete('/api/wishlist/:book_id',auth,(req,res)=>{db.prepare('DELETE FROM wishlists WHERE user_id=? AND book_id=?').run(req.user.id,req.params.book_id);res.json({ok:true});});
app.get('/api/my/wishlist',auth,(req,res)=>res.json(db.prepare('SELECT w.*,b.title,b.author,b.status FROM wishlists w JOIN books b ON b.id=w.book_id WHERE w.user_id=? ORDER BY w.id DESC').all(req.user.id)));
app.post('/api/reviews',auth,(req,res)=>{const {book_id,rating,content}=req.body; db.prepare('INSERT INTO reviews(book_id,user_id,rating,content) VALUES(?,?,?,?)').run(book_id,req.user.id,Math.max(1,Math.min(5,Number(rating||5))),content||''); res.json({ok:true});});
app.get('/api/books/:id/reviews',(req,res)=>res.json(db.prepare('SELECT r.*,u.name user_name FROM reviews r JOIN users u ON u.id=r.user_id WHERE book_id=? ORDER BY r.id DESC').all(req.params.id)));
app.post('/api/my/goal',auth,(req,res)=>{const m=req.body.month||today().slice(0,7); const target=Number(req.body.target||5); db.prepare('INSERT OR REPLACE INTO reading_goals(user_id,month,target) VALUES(?,?,?)').run(req.user.id,m,target); res.json({ok:true});});
app.get('/api/my/goal',auth,(req,res)=>{const m=req.query.month||today().slice(0,7); const goal=db.prepare('SELECT * FROM reading_goals WHERE user_id=? AND month=?').get(req.user.id,m)||{month:m,target:5}; const done=db.prepare("SELECT COUNT(*) c FROM loans WHERE user_id=? AND return_date LIKE ?").get(req.user.id,m+'%').c; res.json({...goal,done});});
app.post('/api/reports',auth,(req,res)=>{db.prepare('INSERT INTO book_reports(user_id,book_id,title,content) VALUES(?,?,?,?)').run(req.user.id,req.body.book_id,req.body.title||'독서기록',req.body.content||''); res.json({ok:true});});
app.get('/api/my/reports',auth,(req,res)=>res.json(db.prepare('SELECT r.*,b.title book_title FROM book_reports r LEFT JOIN books b ON b.id=r.book_id WHERE user_id=? ORDER BY r.id DESC').all(req.user.id)));
app.post('/api/purchase-requests',auth,(req,res)=>{db.prepare('INSERT INTO purchase_requests(user_id,title,author,reason) VALUES(?,?,?,?)').run(req.user.id,req.body.title,req.body.author||'',req.body.reason||''); res.json({ok:true});});
app.get('/api/admin/purchase-requests',auth,admin,(req,res)=>res.json(db.prepare('SELECT p.*,u.name user_name FROM purchase_requests p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC').all()));
app.put('/api/admin/purchase-requests/:id',auth,admin,(req,res)=>{db.prepare('UPDATE purchase_requests SET status=? WHERE id=?').run(req.body.status||'검토중',req.params.id); res.json({ok:true});});
app.post('/api/admin/events',auth,admin,(req,res)=>{db.prepare('INSERT INTO library_events(title,content,event_date) VALUES(?,?,?)').run(req.body.title,req.body.content||'',req.body.event_date||today()); res.json({ok:true});});
app.get('/api/events',(req,res)=>res.json(db.prepare('SELECT * FROM library_events ORDER BY event_date DESC,id DESC').all()));
app.put('/api/admin/books/:id/status',auth,admin,(req,res)=>{db.prepare('UPDATE books SET status=? WHERE id=?').run(req.body.status||'available',req.params.id); db.prepare('INSERT INTO book_status_logs(book_id,status,detail) VALUES(?,?,?)').run(req.params.id,req.body.status||'available',req.body.detail||''); res.json({ok:true});});
app.get('/api/admin/book-status-logs',auth,admin,(req,res)=>res.json(db.prepare('SELECT l.*,b.title FROM book_status_logs l JOIN books b ON b.id=l.book_id ORDER BY l.id DESC LIMIT 200').all()));
app.get('/api/admin/export-xlsx',auth,admin,(req,res)=>{const wb=XLSX.utils.book_new(); for(const [name,sql] of Object.entries({도서:'SELECT * FROM books',회원:'SELECT id,name,username,role,status,suspended_until,created_at FROM users',대출:'SELECT * FROM loans',예약:'SELECT * FROM reservations',희망도서:'SELECT * FROM purchase_requests',독서기록:'SELECT * FROM book_reports'})){XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(db.prepare(sql).all()),name)} const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'}); res.setHeader('Content-Disposition','attachment; filename="minkoju-full-export.xlsx"'); res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.send(buf);});
app.get('/api/dashboard',(req,res)=>{res.json({notices:db.prepare('SELECT * FROM notices ORDER BY pinned DESC,id DESC LIMIT 5').all(),events:db.prepare('SELECT * FROM library_events ORDER BY event_date DESC LIMIT 5').all(),newBooks:db.prepare('SELECT * FROM books ORDER BY id DESC LIMIT 8').all(),popular:db.prepare('SELECT b.title,b.author,COUNT(*) cnt FROM loans l JOIN books b ON b.id=l.book_id GROUP BY b.id ORDER BY cnt DESC LIMIT 6').all(),stats:{books:db.prepare('SELECT COUNT(*) c FROM books').get().c,loaning:db.prepare('SELECT COUNT(*) c FROM loans WHERE return_date IS NULL').get().c,users:db.prepare('SELECT COUNT(*) c FROM users').get().c}})});

app.listen(PORT,()=>console.log(`Minkoju Library 서울급 v7 running: http://localhost:${PORT}`));
