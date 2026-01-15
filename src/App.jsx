import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";
import ExcelJS from "exceljs";

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

function toBRDateTime(iso) {
  try {
    return new Date(iso).toLocaleString("pt-BR");
  } catch {
    return iso;
  }
}

async function downloadBufferAsFile(buffer, filename) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E79" } }; // azul escuro
  row.height = 20;
  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin", color: { argb: "FFCCCCCC" } },
      left: { style: "thin", color: { argb: "FFCCCCCC" } },
      bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
      right: { style: "thin", color: { argb: "FFCCCCCC" } },
    };
  });
}

function styleTableRows(ws, startRow = 2) {
  for (let r = startRow; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    row.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFEEEEEE" } },
        left: { style: "thin", color: { argb: "FFEEEEEE" } },
        bottom: { style: "thin", color: { argb: "FFEEEEEE" } },
        right: { style: "thin", color: { argb: "FFEEEEEE" } },
      };
    });
  }
}

function autoFitColumns(ws, maxWidth = 45) {
  ws.columns.forEach((col) => {
    let maxLen = 10;
    col.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      const txt = v == null ? "" : String(v);
      maxLen = Math.max(maxLen, txt.length);
    });
    col.width = Math.min(maxWidth, maxLen + 2);
  });
}

export default function App() {
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
  const [company, setCompany] = useState("");

  // compras (usuário)
  const [myPurchases, setMyPurchases] = useState([]);

  const monthSum = useMemo(() => myPurchases.reduce((acc, p) => acc + (p.total || 0), 0), [myPurchases]);

  // ADMIN: crédito UI
  const [showCredit, setShowCredit] = useState(false);
  const [creditCompany, setCreditCompany] = useState("FA");
  const [creditQuery, setCreditQuery] = useState("");
  const [employeesAll, setEmployeesAll] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [creditValue, setCreditValue] = useState("");
  const [creditNote, setCreditNote] = useState("");

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
    window.location.reload();
  }

  async function loadProfile() {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, employee_id, is_admin")
      .single();
    if (error) throw error;
    setProfile(data);
    return data;
  }

  async function loadMyEmployeeByUser(userId) {
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, sector, company, credit_balance, active")
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
      .select("id, item, qty, total, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setMyPurchases(data ?? []);
  }

  // ---- ADMIN: carregar lista de colaboradores (pra lançar crédito)
  async function loadEmployeesForCredit() {
    setMsg("");
    const { data, error } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,credit_balance,active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      setMsg(error.message);
      return;
    }
    setEmployeesAll(data ?? []);
  }

  // ---- ADMIN: lançar crédito (RPC)
  async function addCreditAdmin() {
    setMsg("");
    if (!selectedUserId) return setMsg("Selecione uma pessoa.");
    const val = Number(String(creditValue).replace(",", "."));
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
    setSelectedUserId("");

    // atualiza saldo do próprio user se ele for o mesmo
    if (session?.user?.id === selectedUserId) {
      await loadMyEmployeeByUser(session.user.id);
    }
  }

  // ---- EXPORT XLSX (Admin)
  async function exportXLSX(companyFilter) {
    setMsg("");

    // segurança básica: precisa estar logado
    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) return alert("Sessão expirada.");

    const { start, end } = monthRangeISO(new Date());
    const monthLabel = new Date().toISOString().slice(0, 7); // YYYY-MM

    // 1) employees (inclui saldo)
    const { data: emps, error: e1 } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,credit_balance,active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (e1) return alert("Erro employees: " + e1.message);

    const empMap = new Map((emps || []).map((x) => [x.user_id, x]));

    // 2) compras do mês
    const { data: pur, error: e2 } = await supabase
      .from("purchases")
      .select("created_at,user_id,item,unit_price,qty,total")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (e2) return alert("Erro purchases: " + e2.message);

    // 3) lançamentos de crédito do mês (com obs)
    const { data: credits, error: e3 } = await supabase
      .from("credit_ledger")
      .select("created_at,user_id,amount,note")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (e3) return alert("Erro credit_ledger: " + e3.message);

    // normaliza compras
    const detailedRows = (pur || []).map((p) => {
      const emp = empMap.get(p.user_id);
      return {
        Data: toBRDateTime(p.created_at),
        Empresa: emp?.company || "",
        Nome: emp?.name || "",
        Setor: emp?.sector || "",
        Item: formatItem(p.item),
        Qtd: Number(p.qty || 0),
        "Preço Unit": Number(p.unit_price || 0),
        Total: Number(p.total || 0),
        UserId: p.user_id,
      };
    });

    // filtra por empresa
    const detailedFiltered = companyFilter
      ? detailedRows.filter((r) => r.Empresa === companyFilter)
      : detailedRows;

    // resumo compras por usuário
    const sumMap = new Map();
    for (const r of detailedFiltered) {
      const key = `${r.UserId}__${r.Nome}__${r.Setor}__${r.Empresa}`;
      sumMap.set(key, (sumMap.get(key) || 0) + Number(r.Total || 0));
    }

    const summaryRows = Array.from(sumMap.entries()).map(([key, total]) => {
      const [UserId, Nome, Setor, Empresa] = key.split("__");
      return { Empresa, Nome, Setor, "Total do mês": Number(total || 0), UserId };
    });
    summaryRows.sort((a, b) => b["Total do mês"] - a["Total do mês"]);

    // saldos de crédito (visão geral)
    const creditBalances = (emps || [])
      .map((e) => ({
        Empresa: e.company || "",
        Nome: e.name || "",
        Setor: e.sector || "",
        "Crédito atual": Number(e.credit_balance || 0),
        UserId: e.user_id,
      }))
      .filter((r) => (companyFilter ? r.Empresa === companyFilter : true));

    // lançamentos de crédito (do mês)
    const creditLedgerRows = (credits || [])
      .map((c) => {
        const emp = empMap.get(c.user_id);
        return {
          Data: toBRDateTime(c.created_at),
          Empresa: emp?.company || "",
          Nome: emp?.name || "",
          Setor: emp?.sector || "",
          Valor: Number(c.amount || 0),
          Observação: c.note || "",
          UserId: c.user_id,
        };
      })
      .filter((r) => (companyFilter ? r.Empresa === companyFilter : true));

    // monta workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = "Lojinha BF";
    wb.created = new Date();

    // === ABA 1: Compras Detalhado
    const ws1 = wb.addWorksheet("Compras (Detalhado)", { views: [{ state: "frozen", ySplit: 1 }] });
    ws1.addRow(Object.keys(detailedFiltered[0] || {
      Data: "", Empresa: "", Nome: "", Setor: "", Item: "", Qtd: "", "Preço Unit": "", Total: "", UserId: ""
    }));
    styleHeader(ws1.getRow(1));

    detailedFiltered.forEach((r) => ws1.addRow(Object.values(r)));
    ws1.getColumn(7).numFmt = '"R$" #,##0.00';
    ws1.getColumn(8).numFmt = '"R$" #,##0.00';
    styleTableRows(ws1, 2);
    autoFitColumns(ws1);

    // === ABA 2: Resumo
    const ws2 = wb.addWorksheet("Resumo (por pessoa)", { views: [{ state: "frozen", ySplit: 1 }] });
    ws2.addRow(["Empresa", "Nome", "Setor", "Total do mês", "UserId"]);
    styleHeader(ws2.getRow(1));
    summaryRows.forEach((r) => ws2.addRow([r.Empresa, r.Nome, r.Setor, r["Total do mês"], r.UserId]));
    ws2.getColumn(4).numFmt = '"R$" #,##0.00';
    styleTableRows(ws2, 2);
    autoFitColumns(ws2);

    // === ABA 3: Créditos (Saldos + Lançamentos)
    const ws3 = wb.addWorksheet("Créditos", { views: [{ state: "frozen", ySplit: 1 }] });

    // seção saldos
    ws3.addRow(["SALDOS (crédito atual)"]);
    ws3.getRow(1).font = { bold: true, size: 14 };
    ws3.addRow(["Empresa", "Nome", "Setor", "Crédito atual", "UserId"]);
    styleHeader(ws3.getRow(2));
    creditBalances.forEach((r) => ws3.addRow([r.Empresa, r.Nome, r.Setor, r["Crédito atual"], r.UserId]));
    const saldoStartRow = 3;
    ws3.getColumn(4).numFmt = '"R$" #,##0.00';

    // linha em branco
    ws3.addRow([]);
    const ledgerTitleRow = ws3.rowCount + 1;

    // seção lançamentos
    ws3.addRow(["LANÇAMENTOS DE CRÉDITO (mês)"]);
    ws3.getRow(ledgerTitleRow).font = { bold: true, size: 14 };

    ws3.addRow(["Data", "Empresa", "Nome", "Setor", "Valor", "Observação", "UserId"]);
    styleHeader(ws3.getRow(ledgerTitleRow + 1));

    creditLedgerRows.forEach((r) =>
      ws3.addRow([r.Data, r.Empresa, r.Nome, r.Setor, r.Valor, r.Observação, r.UserId])
    );

    // estilos colunas de valores e bordas
    ws3.getColumn(5).numFmt = '"R$" #,##0.00';
    styleTableRows(ws3, 3);
    autoFitColumns(ws3, 60);

    const fileName = `lojinha_${companyFilter || "GERAL"}_${monthLabel}.xlsx`;
    const buffer = await wb.xlsx.writeBuffer();
    await downloadBufferAsFile(buffer, fileName);
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

  // Quando onboarding terminar, carregar compras
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

  // --- TELAS ---

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
              placeholder="seuemail@emcompre.com.br"
            />
            <button className="btnPrimary" type="submit">Enviar link</button>
            {msg && <div className="msg">{msg}</div>}
          </form>
        </div>
      </div>
    );
  }

  // Onboarding simples (mantive sem PIN aqui porque você já está com isso em outra versão.
  // Se quiser, eu integro PIN aqui também sem mexer no layout.)
  if (needsOnboarding) {
    return (
      <div className="page">
        <div className="authCard">
          <div className="topRow">
            <div>
              <div className="brandTitle">Complete seu cadastro</div>
              <div className="brandSubtitle">
                Primeiro acesso. Preencha nome, setor e empresa para liberar o uso da lojinha.
              </div>
            </div>
            <button className="btnGhost" onClick={signOut}>Sair</button>
          </div>

          <div className="divider" />

          <div className="form">
            <label className="label">Nome completo</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />

            <label className="label">Setor</label>
            <input className="input" value={sector} onChange={(e) => setSector(e.target.value)} />

            <label className="label">Empresa</label>
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">Selecione...</option>
              <option value="FA">F.A</option>
              <option value="BF">BF Colchões</option>
            </select>

            <button
              className="btnPrimary"
              onClick={async () => {
                setMsg("");
                if (!fullName.trim() || !sector.trim() || !company) return setMsg("Preencha nome, setor e empresa.");

                const userId = session.user.id;

                const { data, error } = await supabase
                  .from("employees")
                  .insert([{ user_id: userId, name: fullName.trim(), sector: sector.trim(), company, active: true }])
                  .select("id")
                  .single();

                if (error) return setMsg(error.message);

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

  // Tela principal (sem mexer em responsividade/estilo - usa suas classes)
  return (
    <div className="shell">
      <div className="container">
        <div className="topbar">
          <h2 style={{ marginRight: "auto" }}>🍫 Lojinha</h2>

          <div className="badge">
            {session.user.email}
            {myEmployee ? ` • ${myEmployee.name} (${myEmployee.sector}${myEmployee.company ? ` / ${myEmployee.company}` : ""})` : ""}
            {profile?.is_admin ? " • ADM" : ""}
          </div>

          <button className="btnGhost" onClick={signOut}>Sair</button>
        </div>

        <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>
          Crédito disponível: <b>{brl(myEmployee?.credit_balance || 0)}</b>
        </div>

        {msg && <div className="msg" style={{ marginTop: 10 }}>{msg}</div>}

        <div className="grid">
          {/* Extrato */}
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
                      <td>{toBRDateTime(p.created_at)}</td>
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
          </div>

          {/* ADMIN */}
          {profile?.is_admin && (
            <div className="card">
              <h3 className="cardTitle">🛠 Admin</h3>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={() => exportXLSX("FA")}>Exportar Excel F.A (mês)</button>
                <button onClick={() => exportXLSX("BF")}>Exportar Excel BF (mês)</button>
                <button onClick={() => exportXLSX("")}>Exportar Excel Geral (mês)</button>

                <button
                  onClick={async () => {
                    setShowCredit((v) => !v);
                    if (!employeesAll.length) await loadEmployeesForCredit();
                  }}
                >
                  Lançar crédito
                </button>
              </div>

              {showCredit && (
                <div style={{ marginTop: 12, borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 12 }}>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ fontWeight: 700 }}>💳 Lançar crédito</div>
                    <button className="btnGhost" onClick={() => setShowCredit(false)}>Fechar</button>
                  </div>

                  <label className="label" style={{ marginTop: 10 }}>Empresa</label>
                  <select className="input" value={creditCompany} onChange={(e) => setCreditCompany(e.target.value)}>
                    <option value="FA">F.A</option>
                    <option value="BF">BF Colchões</option>
                  </select>

                  <label className="label" style={{ marginTop: 10 }}>Buscar (nome / setor)</label>
                  <input
                    className="input"
                    value={creditQuery}
                    onChange={(e) => setCreditQuery(e.target.value)}
                    placeholder="Ex: Ana, Financeiro..."
                  />

                  <label className="label" style={{ marginTop: 10 }}>Pessoa</label>
                  <select className="input" value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
                    <option value="">Selecione...</option>
                    {employeesAll
                      .filter((e) => e.company === creditCompany)
                      .filter((e) => {
                        const s = creditQuery.trim().toLowerCase();
                        if (!s) return true;
                        return `${e.name} ${e.sector}`.toLowerCase().includes(s);
                      })
                      .slice(0, 300)
                      .map((e) => (
                        <option key={e.user_id} value={e.user_id}>
                          {e.name} — {e.sector} (Saldo: {brl(e.credit_balance || 0)})
                        </option>
                      ))}
                  </select>

                  <label className="label" style={{ marginTop: 10 }}>Valor do crédito (R$)</label>
                  <input
                    className="input"
                    inputMode="decimal"
                    value={creditValue}
                    onChange={(e) => setCreditValue(e.target.value)}
                    placeholder="Ex: 10,00"
                  />

                  <label className="label" style={{ marginTop: 10 }}>Observação (opcional)</label>
                  <input
                    className="input"
                    value={creditNote}
                    onChange={(e) => setCreditNote(e.target.value)}
                    placeholder="Ex: troco / pagamento parcial / etc"
                  />

                  <button className="btnPrimary" onClick={addCreditAdmin} style={{ marginTop: 12 }}>
                    Confirmar crédito
                  </button>

                  <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
                    Esse lançamento aparece na aba <b>Créditos</b> (lançamentos do mês) do Excel.
                  </div>
                </div>
              )}

              <p style={{ opacity: 0.75, marginTop: 10 }}>
                Exportação mensal pega somente compras/créditos do mês atual (de 1º dia até o próximo mês).
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
