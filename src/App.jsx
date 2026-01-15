import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";
import ExcelJS from "exceljs/dist/exceljs.min.js";

let audioCh = null;

async function getAudioChannel() {
  if (audioCh) return audioCh;

  audioCh = supabase.channel("lojinha-audio", {
    config: { broadcast: { self: false } },
  });

  await new Promise((resolve) => {
    audioCh.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
    });
  });

  return audioCh;
}

const PRICES = {
  DOCE_SALGADINHO: 2,
  RED_BULL: 7,
  CAPSULA_CAFE: 1.5,
};

function brl(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n || 0));
}

function formatItem(item) {
  switch (item) {
    case "RED_BULL":
      return "Red Bull";
    case "CAPSULA_CAFE":
      return "Cápsula de Café";
    default:
      return "Doce/Salgadinho";
  }
}

function monthRangeISO(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function safeDec(v) {
  // aceita "10,50" ou "10.50"
  const n = Number(String(v ?? "").replace(".", "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function normalizePin(v) {
  return String(v || "").replace(/\D/g, "").slice(0, 4);
}

/**
 * Tela: Alterar PIN via link (/?change_pin=1)
 * O link do email autentica o usuário e cai aqui.
 */
function ChangePinScreen() {
  const [p1, setP1] = useState("");
  const [p2, setP2] = useState("");
  const [msg, setMsg] = useState("");
  const [show, setShow] = useState(false);

  async function save() {
    setMsg("");
    const a = normalizePin(p1);
    const b = normalizePin(p2);
    if (a.length !== 4 || b.length !== 4) return setMsg("PIN precisa ter 4 dígitos.");
    if (a !== b) return setMsg("PIN e confirmação não conferem.");

    const { error } = await supabase.rpc("set_my_pin", { p_pin: a });
    if (error) return setMsg(error.message);

    setMsg("PIN atualizado ✅ Você já pode voltar ao app.");
  }

  return (
    <div className="page">
      <div className="authCard">
        <div className="brandTitle">🔐 Alterar PIN</div>
        <div className="brandSubtitle">Defina um novo PIN de 4 dígitos</div>
        <div className="divider" />

        <div className="form">
          <label className="label">Novo PIN</label>
          <input
            className="input"
            inputMode="numeric"
            maxLength={4}
            value={p1}
            type={show ? "text" : "password"}
            onChange={(e) => setP1(normalizePin(e.target.value))}
            placeholder="••••"
          />

          <label className="label">Confirmar novo PIN</label>
          <input
            className="input"
            inputMode="numeric"
            maxLength={4}
            value={p2}
            type={show ? "text" : "password"}
            onChange={(e) => setP2(normalizePin(e.target.value))}
            placeholder="••••"
          />

          <button className="btnGhost" type="button" onClick={() => setShow((v) => !v)}>
            {show ? "Ocultar" : "Mostrar"}
          </button>

          <button className="btnPrimary" type="button" onClick={save}>
            Salvar novo PIN
          </button>

          {msg && <div className="msg">{msg}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * Modo BALCÃO (tablet) - compra somente aqui
 * URL: /?kiosk=1
 */
function KioskPurchase({ session, profile }) {
  const [msg, setMsg] = useState("");
  const [company, setCompany] = useState("FA");
  const [q, setQ] = useState("");
  const [employees, setEmployees] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedLabel, setSelectedLabel] = useState("");

  const [item, setItem] = useState("DOCE_SALGADINHO");
  const [qty, setQty] = useState(1);
  const [pin, setPin] = useState("");
  const totalNow = useMemo(() => Number(PRICES[item]) * Math.max(1, Number(qty || 1)), [item, qty]);

  useEffect(() => {
    (async () => {
      setMsg("");
      // Carrega lista (somente campos necessários, SEM crédito)
      const { data, error } = await supabase
        .from("employees")
        .select("user_id,name,sector,company,active")
        .eq("active", true)
        .order("name", { ascending: true });

      if (error) return setMsg(error.message);
      setEmployees(data ?? []);
    })();
  }, []);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (employees || [])
      .filter((e) => e.company === company)
      .filter((e) => {
        if (!s) return true;
        return `${e.name} ${e.sector}`.toLowerCase().includes(s);
      })
      .slice(0, 200);
  }, [employees, company, q]);

  async function confirmPurchase() {
    setMsg("");

    // validações
    if (!profile?.is_admin) return setMsg("Acesso negado (somente ADM pode operar o balcão).");
    if (!selectedUserId) return setMsg("Selecione uma pessoa.");
    const p = normalizePin(pin);
    if (p.length !== 4) return setMsg("Informe o PIN (4 dígitos).");

    // 1) verifica PIN no banco
    const { data: ok, error: ePin } = await supabase.rpc("verify_pin", {
      p_user: selectedUserId,
      p_pin: p,
    });
    if (ePin) return setMsg(ePin.message);
    if (!ok) return setMsg("PIN incorreto ❌");

    // 2) insere compra para o user selecionado
    const payload = {
      user_id: selectedUserId,
      item,
      unit_price: Number(PRICES[item]),
      qty: Math.max(1, Number(qty || 1)),
      total: Number(totalNow),
    };

    const { error: eIns } = await supabase.from("purchases").insert([payload]);
    if (eIns) return setMsg(eIns.message);

    // 3) broadcast (opcional) para outro aparelho tocar som
    try {
      const ch = await getAudioChannel();
      await ch.send({
        type: "broadcast",
        event: "purchase_registered",
        payload: {
          name: selectedLabel || "Compra registrada",
          company,
          item: formatItem(item),
          qty: payload.qty,
          total: payload.total,
        },
      });
    } catch {
      // silencioso
    }

    // 4) feedback local (som do próprio tablet)
    try {
      const a = new Audio("/confirm.mp3");
      a.volume = 1;
      a.play().catch(() => {});
    } catch {}

    setMsg("Compra registrada ✅");
    setPin("");
    setQty(1);
  }

  return (
    <div className="shell">
      <div className="container">
        <div className="topbar">
          <h2 style={{ marginRight: "auto" }}>🧾 Modo Balcão</h2>
          <div className="badge">
            {session?.user?.email} {profile?.is_admin ? " • ADM" : ""}
          </div>
        </div>

        {msg && <div className="msg">{msg}</div>}

        <div className="grid">
          <div className="card">
            <h3 className="cardTitle">👤 Identificar colaborador</h3>

            <div className="form">
              <label className="label">Empresa</label>
              <select className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
                <option value="FA">F.A</option>
                <option value="BF">BF Colchões</option>
              </select>

              <label className="label">Buscar (nome / setor)</label>
              <input
                className="input"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Ex: Ana, Financeiro..."
              />

              <label className="label">Pessoa</label>
              <select
                className="input"
                value={selectedUserId}
                onChange={(e) => {
                  const uid = e.target.value;
                  setSelectedUserId(uid);
                  const emp = filtered.find((x) => x.user_id === uid);
                  setSelectedLabel(emp ? `${emp.name} — ${emp.sector}` : "");
                }}
              >
                <option value="">Selecione...</option>
                {filtered.map((e) => (
                  <option key={e.user_id} value={e.user_id}>
                    {e.name} — {e.sector}
                  </option>
                ))}
              </select>

              {selectedLabel && (
                <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                  Selecionado: <b>{selectedLabel}</b>
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h3 className="cardTitle">🛒 Registrar compra (PIN obrigatório)</h3>

            <div className="purchaseGrid">
              <label style={{ display: "grid", gap: 6 }}>
                <span>Item</span>
                <select value={item} onChange={(e) => setItem(e.target.value)}>
                  <option value="DOCE_SALGADINHO">Doce/Salgadinho (R$ 2,00)</option>
                  <option value="CAPSULA_CAFE">Cápsula de Café (R$ 1,50)</option>
                  <option value="RED_BULL">Red Bull (R$ 7,00)</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span>Qtd</span>
                <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span>Total</span>
                <input value={brl(totalNow)} disabled />
              </label>
            </div>

            <div style={{ marginTop: 10 }}>
              <label className="label">PIN (4 dígitos)</label>
              <input
                className="input"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                type="password"
                onChange={(e) => setPin(normalizePin(e.target.value))}
                placeholder="••••"
              />
            </div>

            <button className="btnPrimary" onClick={confirmPurchase} style={{ marginTop: 12 }}>
              Confirmar compra
            </button>

            <p style={{ opacity: 0.7, marginTop: 10, fontSize: 12 }}>
              Obs: O app normal (celular) não registra compra. Compra é somente aqui no balcão.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  // rotas por querystring
  const qs = new URLSearchParams(window.location.search);
  const isKiosk = qs.get("kiosk") === "1";
  const isChangePin = qs.get("change_pin") === "1";

  // auth
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  // profile / employee
  const [profile, setProfile] = useState(null);
  const [myEmployee, setMyEmployee] = useState(null);

  // onboarding (cadastro)
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [fullName, setFullName] = useState("");
  const [sector, setSector] = useState("");
  const [company, setCompany] = useState(""); // FA/BF

  // PIN cadastro
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [pinVisible, setPinVisible] = useState(false);


const [showPin, setShowPin] = useState(false);

// PIN (tela usuário / mostrar-validar)
const [pinViewMode, setPinViewMode] = useState("hidden"); 
// "hidden" | "shown"



  // extrato (usuário)
  const [myPurchases, setMyPurchases] = useState([]);

  const monthSum = useMemo(() => myPurchases.reduce((acc, p) => acc + (p.total || 0), 0), [myPurchases]);

  // crédito (admin)
  const [showCredit, setShowCredit] = useState(false);
  const [creditQuery, setCreditQuery] = useState("");
  const [creditCompany, setCreditCompany] = useState("FA");
  const [creditValue, setCreditValue] = useState("");
  const [creditNote, setCreditNote] = useState("");
  const [employeesAll, setEmployeesAll] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");

  // Auth listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendMagicLink(e) {
    e.preventDefault();
    setMsg("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) return setMsg(error.message);
    setMsg("Link de acesso enviado para seu e-mail 📩");
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = window.location.origin;
  }

  async function loadProfile() {
    const { data, error } = await supabase.from("profiles").select("user_id, employee_id, is_admin").single();
    if (error) throw error;
    setProfile(data);
    return data;
  }

  async function loadMyEmployeeByUser(userId) {
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, sector, company, credit_balance, active, pin_hash")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    setMyEmployee(data ?? null);
    return data ?? null;
  }

  async function ensureOnboarding() {
    const userId = session?.user?.id;
    if (!userId) return;

    const emp = await loadMyEmployeeByUser(userId);
    if (!emp) {
      setNeedsOnboarding(true);
      return;
    }

    const prof = await loadProfile();
    if (!prof.employee_id) {
      await supabase.from("profiles").update({ employee_id: emp.id }).eq("user_id", userId);
      const updated = await loadProfile();
      setProfile(updated);
    }
    setNeedsOnboarding(false);
  }

  async function loadMyPurchasesThisMonth() {
    const { start, end } = monthRangeISO(new Date());
    const { data, error } = await supabase
      .from("purchases")
      .select("id, user_id, item, unit_price, qty, total, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setMyPurchases(data ?? []);
  }

  // ADMIN: carregar funcionários p/ crédito
  async function loadEmployeesForCredit() {
    const { data, error } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      setMsg(error.message);
      return;
    }
    setEmployeesAll(data ?? []);
  }

  async function addCreditAdmin() {
    setMsg("");
    if (!selectedUserId) return setMsg("Selecione uma pessoa.");

    const val = safeDec(creditValue);
    if (!Number.isFinite(val) || val <= 0) return setMsg("Informe um valor válido (> 0).");

    const { error } = await supabase.rpc("admin_add_credit", {
      p_user: selectedUserId,
      p_amount: val,
      p_note: creditNote?.trim() ? creditNote.trim() : null,
    });

    if (error) return setMsg(error.message);

    setMsg("Crédito lançado com sucesso ✅");
    setCreditValue("");
    setCreditNote("");

    // atualiza saldo do usuário logado (se for ele)
    if (session?.user?.id === selectedUserId) {
      await loadMyEmployeeByUser(session.user.id);
    }
  }

  // EXPORT XLSX (Admin) - com compras + resumo + créditos + ledger
  async function exportExcel(companyFilter) {
    setMsg("");

    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) return alert("Sessão expirada.");

    // 1) employees (inclui saldo de crédito)
    const { data: emps, error: e1 } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,active,credit_balance")
      .eq("active", true)
      .order("name", { ascending: true });

    if (e1) return alert("Erro employees: " + e1.message);

    const empList = (emps || []).filter((x) => !companyFilter || x.company === companyFilter);
    const empMap = new Map(empList.map((x) => [x.user_id, x]));

    // 2) compras do mês
    const { start: mStart, end: mEnd } = monthRangeISO(new Date());
    const { data: pur, error: e2 } = await supabase
      .from("purchases")
      .select("created_at,user_id,item,unit_price,qty,total")
      .gte("created_at", mStart)
      .lt("created_at", mEnd)
      .order("created_at", { ascending: false });

    if (e2) return alert("Erro purchases: " + e2.message);

    const purchases = (pur || [])
      .map((p) => {
        const emp = empMap.get(p.user_id);
        return {
          created_at: p.created_at,
          empresa: emp?.company ?? "",
          nome: emp?.name ?? "",
          setor: emp?.sector ?? "",
          item: formatItem(p.item),
          qtd: p.qty,
          unit: Number(p.unit_price || 0),
          total: Number(p.total || 0),
          user_id: p.user_id,
        };
      })
      .filter((r) => !companyFilter || r.empresa === companyFilter);

    // 3) credit_ledger do mês (com obs)
    const { data: led, error: e3 } = await supabase
      .from("credit_ledger")
      .select("created_at,user_id,amount,note")
      .gte("created_at", mStart)
      .lt("created_at", mEnd)
      .order("created_at", { ascending: false });

    if (e3) return alert("Erro credit_ledger: " + e3.message);

    const ledger = (led || [])
      .map((l) => {
        const emp = empMap.get(l.user_id);
        return {
          created_at: l.created_at,
          empresa: emp?.company ?? "",
          nome: emp?.name ?? "",
          setor: emp?.sector ?? "",
          amount: Number(l.amount || 0),
          note: l.note ?? "",
          user_id: l.user_id,
        };
      })
      .filter((r) => !companyFilter || r.empresa === companyFilter);

    // 4) resumo por usuário (compras do mês)
    const sumMap = new Map();
    for (const r of purchases) {
      const key = r.user_id;
      const prev = sumMap.get(key) || 0;
      sumMap.set(key, prev + Number(r.total || 0));
    }

    const summary = Array.from(sumMap.entries()).map(([user_id, total_mes]) => {
      const emp = empMap.get(user_id);
      return {
        empresa: emp?.company ?? "",
        nome: emp?.name ?? "",
        setor: emp?.sector ?? "",
        total_mes: Number(total_mes || 0),
        credit_balance: Number(emp?.credit_balance || 0),
        user_id,
      };
    });

    summary.sort((a, b) => b.total_mes - a.total_mes);

    // 5) planilha (Excel)
    const wb = new ExcelJS.Workbook();
    wb.creator = "Lojinha BF";
    wb.created = new Date();

    const headerStyle = {
      font: { bold: true, color: { argb: "FFFFFFFF" } },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF2B2F3A" } },
      alignment: { vertical: "middle", horizontal: "center" },
    };

    function applyTable(ws, columns) {
      ws.columns = columns;
      ws.getRow(1).height = 20;
      ws.getRow(1).eachCell((cell) => {
        cell.style = headerStyle;
        cell.border = {
          top: { style: "thin", color: { argb: "FFCCCCCC" } },
          left: { style: "thin", color: { argb: "FFCCCCCC" } },
          bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
          right: { style: "thin", color: { argb: "FFCCCCCC" } },
        };
      });

      // freeze header
      ws.views = [{ state: "frozen", ySplit: 1 }];

      // autofilter
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: columns.length },
      };
    }

    // Aba 1: Compras (Detalhado)
    const ws1 = wb.addWorksheet("Compras (Detalhado)");
    applyTable(ws1, [
      { header: "Data", key: "data", width: 20 },
      { header: "Empresa", key: "empresa", width: 10 },
      { header: "Nome", key: "nome", width: 26 },
      { header: "Setor", key: "setor", width: 18 },
      { header: "Item", key: "item", width: 18 },
      { header: "Qtd", key: "qtd", width: 8 },
      { header: "Preço Unit", key: "unit", width: 12 },
      { header: "Total", key: "total", width: 12 },
      { header: "UserId", key: "user_id", width: 38 },
    ]);

    purchases.forEach((r) => {
      ws1.addRow({
        data: new Date(r.created_at).toLocaleString("pt-BR"),
        empresa: r.empresa,
        nome: r.nome,
        setor: r.setor,
        item: r.item,
        qtd: r.qtd,
        unit: r.unit,
        total: r.total,
        user_id: r.user_id,
      });
    });

    ws1.getColumn("unit").numFmt = '"R$" #,##0.00';
    ws1.getColumn("total").numFmt = '"R$" #,##0.00';

    // Aba 2: Resumo por usuário
    const ws2 = wb.addWorksheet("Resumo por usuário");
    applyTable(ws2, [
      { header: "Empresa", key: "empresa", width: 10 },
      { header: "Nome", key: "nome", width: 26 },
      { header: "Setor", key: "setor", width: 18 },
      { header: "Total do mês", key: "total_mes", width: 14 },
      { header: "Crédito atual", key: "credit_balance", width: 14 },
      { header: "UserId", key: "user_id", width: 38 },
    ]);

    summary.forEach((r) => {
      ws2.addRow(r);
    });

    ws2.getColumn("total_mes").numFmt = '"R$" #,##0.00';
    ws2.getColumn("credit_balance").numFmt = '"R$" #,##0.00';

    // Aba 3: Créditos (Saldo atual)
    const ws3 = wb.addWorksheet("Créditos (Saldo atual)");
    applyTable(ws3, [
      { header: "Empresa", key: "company", width: 10 },
      { header: "Nome", key: "name", width: 26 },
      { header: "Setor", key: "sector", width: 18 },
      { header: "Crédito atual", key: "credit_balance", width: 14 },
      { header: "UserId", key: "user_id", width: 38 },
    ]);

    empList.forEach((e) => {
      ws3.addRow({
        company: e.company,
        name: e.name,
        sector: e.sector,
        credit_balance: Number(e.credit_balance || 0),
        user_id: e.user_id,
      });
    });
    ws3.getColumn("credit_balance").numFmt = '"R$" #,##0.00';

    // Aba 4: Lançamentos de crédito (mês)
    const ws4 = wb.addWorksheet("Lançamentos crédito (mês)");
    applyTable(ws4, [
      { header: "Data", key: "data", width: 20 },
      { header: "Empresa", key: "empresa", width: 10 },
      { header: "Nome", key: "nome", width: 26 },
      { header: "Setor", key: "setor", width: 18 },
      { header: "Valor", key: "amount", width: 12 },
      { header: "Obs", key: "note", width: 32 },
      { header: "UserId", key: "user_id", width: 38 },
    ]);

    ledger.forEach((l) => {
      ws4.addRow({
        data: new Date(l.created_at).toLocaleString("pt-BR"),
        empresa: l.empresa,
        nome: l.nome,
        setor: l.setor,
        amount: l.amount,
        note: l.note,
        user_id: l.user_id,
      });
    });
    ws4.getColumn("amount").numFmt = '"R$" #,##0.00';

    // gerar arquivo
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lojinha_${companyFilter || "GERAL"}_${new Date().toISOString().slice(0, 7)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Quando loga: carrega profile e verifica onboarding
  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      try {
        setMsg("");
        await loadProfile();
        await ensureOnboarding();
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // Quando onboarding terminar, carrega extrato
  useEffect(() => {
    if (!session?.user?.id) return;
    if (needsOnboarding) return;
    (async () => {
      try {
        await loadMyPurchasesThisMonth();
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsOnboarding, session?.user?.id]);

  // Se caiu aqui via link de troca de PIN
  if (isChangePin) {
    return <ChangePinScreen />;
  }

  // Tela login
  if (!session) {
    return (
      <div className="page">
        <div className="authCard">
          <div className="brandRow">
            <img src="/favicon.ico" alt="BF" className="brandLogo" />
            <div>
              <div className="brandTitle">Lojinha BF</div>
              <div className="brandSubtitle">Controle interno de compras</div>
            </div>
          </div>

          <div className="divider" />

          <form onSubmit={sendMagicLink} className="form">
            <label className="label">E-mail</label>
            <input
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seuemail@empresa.com.br"
            />

            <button className="btnPrimary" type="submit">
              Enviar link
            </button>

            {msg && <div className="msg">{msg}</div>}
          </form>
        </div>
      </div>
    );
  }

  // Se for modo balcão (tablet), renderiza compra aqui (somente ADM)
  if (isKiosk) {
    return <KioskPurchase session={session} profile={profile} />;
  }

  // Tela de cadastro (aparece no 1º acesso)
  if (needsOnboarding) {
    return (
      <div className="page">
        <div className="authCard">
          <div className="topRow">
            <div>
              <div className="brandTitle">Complete seu cadastro</div>
              <div className="brandSubtitle">
                Primeiro acesso. Preencha nome, setor, empresa e crie seu PIN (4 dígitos).
              </div>
            </div>
            <button className="btnGhost" onClick={signOut}>
              Sair
            </button>
          </div>

          <div className="divider" />

          <div className="form">
            <label className="label">Nome completo</label>
            <input
              className="input"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Seu nome completo"
            />

            <label className="label">Setor</label>
            <input className="input" value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Seu setor" />

            <label className="label">Empresa</label>
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">Selecione...</option>
              <option value="FA">F.A</option>
              <option value="BF">BF Colchões</option>
            </select>

            <label className="label">PIN (4 dígitos)</label>
            <input
              className="input"
              inputMode="numeric"
              maxLength={4}
              value={pin1}
              type={pinVisible ? "text" : "password"}
              onChange={(e) => setPin1(normalizePin(e.target.value))}
              placeholder="••••"
            />

            <label className="label">Confirmar PIN</label>
            <input
              className="input"
              inputMode="numeric"
              maxLength={4}
              value={pin2}
              type={pinVisible ? "text" : "password"}
              onChange={(e) => setPin2(normalizePin(e.target.value))}
              placeholder="••••"
            />

            <button className="btnGhost" type="button" onClick={() => setPinVisible((v) => !v)}>
              {pinVisible ? "Ocultar PIN" : "Mostrar PIN"}
            </button>

            <button
              className="btnPrimary"
              onClick={async () => {
                setMsg("");

                const pA = normalizePin(pin1);
                const pB = normalizePin(pin2);

                if (!fullName.trim() || !sector.trim() || !company) return setMsg("Preencha nome, setor e empresa.");
                if (pA.length !== 4 || pB.length !== 4) return setMsg("PIN precisa ter 4 dígitos.");
                if (pA !== pB) return setMsg("PIN e confirmação não conferem.");

                const userId = session.user.id;

                const { data, error } = await supabase
                  .from("employees")
                  .insert([{ user_id: userId, name: fullName.trim(), sector: sector.trim(), company, active: true }])
                  .select("id")
                  .single();

                if (error) return setMsg(error.message);

                // salva PIN (hash no banco)
                const { error: ePin } = await supabase.rpc("set_my_pin", { p_pin: pA });
                if (ePin) return setMsg(ePin.message);

                const { error: e2 } = await supabase.from("profiles").update({ employee_id: data.id }).eq("user_id", userId);
                if (e2) return setMsg(e2.message);

                setNeedsOnboarding(false);
                await loadProfile();
                await loadMyEmployeeByUser(userId);
              }}
            >
              Salvar cadastro
            </button>

            {msg && <div className="msg">{msg}</div>}
          </div>
        </div>
      </div>
    );
  }

  // Tela principal (usuário) — sem comprar
  return (
    <div className="shell">
      <div className="container">
        <div className="topbar">
          <h2 style={{ marginRight: "auto" }}>🍫 Lojinha BF</h2>

          <div className="badge">
            {session.user.email}
            {myEmployee
              ? ` • ${myEmployee.name} (${myEmployee.sector}${myEmployee.company ? ` / ${myEmployee.company}` : ""})`
              : ""}
            {profile?.is_admin ? " • ADM" : ""}
          </div>

          <button className="btnGhost" onClick={signOut}>
            Sair
          </button>
        </div>

        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
          Crédito disponível: <b>{brl(myEmployee?.credit_balance || 0)}</b>
        </div>

        {/* PIN (mostrar/alterar) */}
<div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
  PIN: <b>{showPin ? "****" : "••••"}</b>{" "}
  <button
    className="btnGhost"
    type="button"
    onClick={() => setShowPin((v) => !v)}
    style={{ marginLeft: 6 }}
  >
    {showPin ? "Ocultar PIN" : "Mostrar PIN"}
  </button>{" "}
  <button
    className="btnGhost"
    type="button"
    onClick={async () => {
      setMsg("");
      const { error } = await supabase.auth.signInWithOtp({
        email: session.user.email,
        options: { emailRedirectTo: window.location.origin + "/?change_pin=1" },
      });
      if (error) return setMsg(error.message);
      setMsg("Enviamos um link para alterar seu PIN no seu e-mail 📩");
    }}
  >
    Alterar PIN (via e-mail)
  </button>
</div>


        {pinViewMode && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Digite seu PIN atual para exibir</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                className="input"
                style={{ flex: 1 }}
                inputMode="numeric"
                maxLength={4}
                value={pinCheck}
                onChange={(e) => setPinCheck(normalizePin(e.target.value))}
                placeholder="••••"
                type="password"
              />
              <button
                className="btnPrimary"
                type="button"
                onClick={async () => {
                  setMsg("");
                  if (pinCheck.length !== 4) return setMsg("Informe 4 dígitos.");
                  const { data, error } = await supabase.rpc("verify_pin", {
                    p_user: session.user.id,
                    p_pin: pinCheck,
                  });
                  if (error) return setMsg(error.message);
                  if (!data) return setMsg("PIN incorreto ❌");
                  setPinOk(true);
                  setMsg("PIN exibido ✅");
                }}
              >
                Confirmar
              </button>
            </div>
          </div>
        )}

        {msg && <div className="msg" style={{ marginTop: 10 }}>{msg}</div>}

        <div className="grid" style={{ marginTop: 12 }}>
          {/* Card: Meu gasto do mês */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h3 className="cardTitle" style={{ marginRight: "auto" }}>
                📆 Meu gasto do mês {myEmployee?.name ? `— ${myEmployee.name}` : ""}
              </h3>
              <div className="monoTotal">{brl(monthSum)}</div>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Item</th>
                    <th>Qtd</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {myPurchases.map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.created_at).toLocaleString("pt-BR")}</td>
                      <td>{formatItem(p.item)}</td>
                      <td>{p.qty}</td>
                      <td>{brl(p.total)}</td>
                    </tr>
                  ))}
                  {myPurchases.length === 0 && (
                    <tr>
                      <td colSpan="4" style={{ opacity: 0.7 }}>
                        Sem compras neste mês.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <p style={{ opacity: 0.7, marginTop: 10, fontSize: 12 }}>
              Compras são registradas somente no balcão (tablet).
            </p>
          </div>

          {/* Card: Admin */}
          {profile?.is_admin && (
            <div className="card">
              <h3 className="cardTitle">🛠 Admin</h3>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={() => exportExcel("FA")}>Exportar Excel F.A (mês)</button>
                <button onClick={() => exportExcel("BF")}>Exportar Excel BF (mês)</button>
                <button onClick={() => exportExcel("")}>Exportar Excel Geral (mês)</button>

                <button
                  onClick={async () => {
                    setShowCredit((v) => !v);
                    await loadEmployeesForCredit();
                  }}
                >
                  Lançar crédito
                </button>

                <button onClick={() => window.open(window.location.origin + "/?kiosk=1", "_blank")}>
                  Abrir modo balcão
                </button>
              </div>

              {showCredit && (
                <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 12 }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ fontWeight: 700 }}>💳 Lançar crédito</div>
                    <button className="btnGhost" onClick={() => setShowCredit(false)}>
                      Fechar
                    </button>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label className="label">Empresa</label>
                    <select className="input" value={creditCompany} onChange={(e) => setCreditCompany(e.target.value)}>
                      <option value="FA">F.A</option>
                      <option value="BF">BF Colchões</option>
                    </select>

                    <label className="label" style={{ marginTop: 10 }}>
                      Buscar (nome / setor)
                    </label>
                    <input
                      className="input"
                      value={creditQuery}
                      onChange={(e) => setCreditQuery(e.target.value)}
                      placeholder="Ex: Ana, Financeiro..."
                    />

                    <label className="label" style={{ marginTop: 10 }}>
                      Pessoa
                    </label>
                    <select className="input" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                      <option value="">Selecione...</option>
                      {(employeesAll || [])
                        .filter((e) => e.company === creditCompany)
                        .filter((e) => {
                          const s = creditQuery.trim().toLowerCase();
                          if (!s) return true;
                          return `${e.name} ${e.sector}`.toLowerCase().includes(s);
                        })
                        .slice(0, 200)
                        .map((e) => (
                          <option key={e.user_id} value={e.user_id}>
                            {e.name} — {e.sector}
                          </option>
                        ))}
                    </select>

                    <label className="label" style={{ marginTop: 10 }}>
                      Valor do crédito (R$)
                    </label>
                    <input
                      className="input"
                      inputMode="decimal"
                      value={creditValue}
                      onChange={(e) => setCreditValue(e.target.value)}
                      placeholder="Ex: 10,00"
                    />

                    <label className="label" style={{ marginTop: 10 }}>
                      Observação (opcional)
                    </label>
                    <input
                      className="input"
                      value={creditNote}
                      onChange={(e) => setCreditNote(e.target.value)}
                      placeholder="Ex: troco, pagamento parcial..."
                    />

                    <button className="btnPrimary" onClick={addCreditAdmin} style={{ marginTop: 12 }}>
                      Confirmar crédito
                    </button>
                  </div>
                </div>
              )}

              <p style={{ opacity: 0.75, marginTop: 10 }}>
                Export Excel inclui: compras do mês, resumo por usuário, saldos atuais de crédito e lançamentos do mês (com obs).
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
