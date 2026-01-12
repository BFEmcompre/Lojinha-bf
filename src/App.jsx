import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

let audioCh = null;

async function getAudioChannel() {
  if (audioCh) return audioCh;

  audioCh = supabase.channel("lojinha-audio", {
    config: { broadcast: { self: false } },
  });

  // garante que o canal está "SUBSCRIBED"
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
  CAPSULA_CAFE: 1.5
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

function downloadCSV(filename, rows) {
  // Excel BR costuma separar por ; e às vezes precisa do BOM
  const SEP = ";";
  const BOM = "\ufeff";
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v ?? "");
          if (s.includes(SEP) || s.includes('"') || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
          return s;
        })
        .join(SEP)
    )
    .join("\n");

  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}


function Kiosk() {
  const [enabled, setEnabled] = useState(false);
  const [lastMsg, setLastMsg] = useState("");

  useEffect(() => {
    const ch = supabase.channel("lojinha-audio", {
      config: { broadcast: { self: false } },
    });

    ch.on("broadcast", { event: "purchase_registered" }, ({ payload }) => {
      setLastMsg(
        `${payload?.name || "Alguém"} registrou: ${payload?.item || ""} (${payload?.company || ""})`
      );

      // toca som (só funciona após 1 interação)
      try {
        const audio = new Audio("/confirm.mp3");
        audio.volume = 1.0;
        audio.play().catch(() => {});
      } catch (e) {}
      
      // fallback: voz do navegador (opcional)

    });

ch.subscribe((status) => {
  console.log("Kiosk channel status:", status);
});


    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  function enableAudio() {
    // desbloqueia autoplay com uma interação
    setEnabled(true);
    const audio = new Audio("/confirm.mp3");
    audio.volume = 0.01;
    audio.play().then(() => audio.pause()).catch(() => {});
  }

  return (
    <div className="page">
      <div className="authCard" style={{ textAlign: "center" }}>
        <div className="brandTitle">🔊 Modo Balcão</div>
        <div className="brandSubtitle">Este aparelho avisa quando alguém registra uma compra</div>

        <div className="divider" />

        {!enabled ? (
          <button className="btnPrimary" onClick={enableAudio}>
            Ativar som
          </button>
        ) : (
          <div style={{ fontSize: 14, opacity: 0.9 }}>
            ✅ Som ativado. Deixe esta tela aberta.
          </div>
        )}

        <div style={{ marginTop: 16, fontSize: 13, opacity: 0.8 }}>
          Último aviso: {lastMsg || "—"}
        </div>
      </div>
    </div>
  );
}


export default function App() {


const isKiosk = new URLSearchParams(window.location.search).get("kiosk") === "1";
if (isKiosk) return <Kiosk />;

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

  // compras (usuário)
  const [item, setItem] = useState("DOCE_SALGADINHO");
  const [qty, setQty] = useState(1);
  const [myPurchases, setMyPurchases] = useState([]);

  const totalNow = useMemo(() => PRICES[item] * Math.max(1, Number(qty || 1)), [item, qty]);
  const monthSum = useMemo(() => myPurchases.reduce((acc, p) => acc + (p.total || 0), 0), [myPurchases]);

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
      .select("id, name, sector, company, active")
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

 async function addPurchase() {
  setMsg("");

  // pega sessão na hora (evita bug de estado antigo)
  const { data: s } = await supabase.auth.getSession();
  const userId = s?.session?.user?.id;
  if (!userId) return setMsg("Sessão expirada. Faça login novamente.");

  const payload = {
    user_id: userId,
    item,
    unit_price: Number(PRICES[item]),
    qty: Math.max(1, Number(qty || 1)),
    total: Number(totalNow),
  };

  const { error } = await supabase.from("purchases").insert([payload]);
  if (error) return setMsg(error.message);

  // ✅ 1) Toca som no próprio celular de quem registrou (opcional)
  try {
    const audio = new Audio("/confirm.mp3");
    audio.volume = 1;
    audio.play().catch(() => {});
  } catch {}

  // ✅ 2) Dispara aviso pro CELULAR DO BALCÃO (Realtime Broadcast)
  // (o balcão precisa estar na tela ?kiosk=1 e já ter clicado "Ativar som")
  try {
    const { data: emp } = await supabase
      .from("employees")
      .select("name, sector, company")
      .eq("user_id", userId)
      .maybeSingle();

   const ch = await getAudioChannel();

await ch.send({
  type: "broadcast",
  event: "purchase_registered",
  payload: {
    name: emp?.name || s.session.user.email,
    sector: emp?.sector || "",
    company: emp?.company || "",
    item: formatItem(item),
    qty: Math.max(1, Number(qty || 1)),
    total: Number(totalNow),
  },
});

  } catch {}

  setQty(1);
  await loadMyPurchasesThisMonth();
}


  // EXPORT ADMIN (seguro): junta por user_id e filtra empresa
  async function exportCSV(companyFilter) {
    setMsg("");

    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) return alert("Sessão expirada.");

    // employees (nome/setor/empresa)
    const { data: emps, error: e1 } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,active");

    if (e1) return alert("Erro employees: " + e1.message);

    const empMap = new Map(
      (emps || [])
        .filter((x) => x.active !== false)
        .map((x) => [x.user_id, x])
    );

    // compras do mês
    const { start, end } = monthRangeISO(new Date());
    const { data: pur, error: e2 } = await supabase
      .from("purchases")
      .select("created_at,user_id,item,unit_price,qty,total")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (e2) return alert("Erro purchases: " + e2.message);

    const rowsObj = (pur || []).map((p) => {
      const emp = empMap.get(p.user_id);
      return {
        data: new Date(p.created_at).toLocaleString("pt-BR"),
        empresa: emp?.company ?? "",
        nome: emp?.name ?? "",
        setor: emp?.sector ?? "",
        item: formatItem(p.item),
        qtd: p.qty,
        unit_price: p.unit_price,
        total: p.total,
        user_id: p.user_id,
      };
    });

    const filtered = companyFilter ? rowsObj.filter((r) => r.empresa === companyFilter) : rowsObj;


// --- RESUMO POR USUÁRIO (soma do mês) ---
const summaryMap = new Map();

for (const r of filtered) {
  const key = `${r.user_id}__${r.nome}__${r.setor}__${r.empresa}`;
  const prev = summaryMap.get(key) || 0;
  summaryMap.set(key, prev + Number(r.total || 0));
}

const summaryRows = Array.from(summaryMap.entries()).map(([key, sum]) => {
  const [user_id, nome, setor, empresa] = key.split("__");
  return { empresa, nome, setor, total_mes: sum, user_id };
});

// ordena do maior pro menor (opcional)
summaryRows.sort((a, b) => b.total_mes - a.total_mes);


const rows = [
  ["DETALHADO"],
  ["Data", "Empresa", "Nome", "Setor", "Item", "Qtd", "Preço Unit", "Total", "UserId"],
  ...filtered.map((r) => [
    r.data,
    r.empresa,
    r.nome,
    r.setor,
    r.item,
    r.qtd,
    r.unit_price,
    r.total,
    r.user_id
  ]),

  [], // linha em branco

  ["RESUMO POR USUÁRIO (TOTAL DO MÊS)"],
  ["Empresa", "Nome", "Setor", "Total do mês", "UserId"],
  ...summaryRows.map((s) => [
    s.empresa,
    s.nome,
    s.setor,
    Number(s.total_mes || 0).toFixed(2).replace(".", ","), // formato BR
    s.user_id
  ]),
];


    downloadCSV(`lojinha_${companyFilter || "GERAL"}_${new Date().toISOString().slice(0, 7)}.csv`, rows);
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

            <button className="btnPrimary" type="submit">
              Enviar link
            </button>

            {msg && <div className="msg">{msg}</div>}
          </form>
        </div>
      </div>
    );
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
              Primeiro acesso. Preencha nome, setor e empresa para liberar o uso da lojinha.
            </div>
          </div>
          <button className="btnGhost" onClick={signOut}>Sair</button>
        </div>

        <div className="divider" />

        <div className="form">
          <label className="label">Nome completo</label>
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Seu nome completo" />

          <label className="label">Setor</label>
          <input className="input" value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Seu setor" />

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


// Tela principal
return (
  <div className="shell">
    <div className="container">
      <div className="topbar">
        <h2 style={{ marginRight: "auto" }}>🍫 Lojinha BF</h2>

        <div style={{ fontSize: 12, opacity: 0.85 }}>
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

      {msg && <p>{msg}</p>}

      <div className="grid">
        {/* Card: Lançar compra */}
        <div className="card">
          <h3 className="cardTitle">🧾 Lançar compra</h3>

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

          <button onClick={addPurchase} style={{ marginTop: 12 }}>
            Confirmar
          </button>
        </div>

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
        </div>

        {/* Card: Admin (somente ADM) */}
        {profile?.is_admin && (
          <div className="card">
            <h3 className="cardTitle">🛠 Admin</h3>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={() => exportCSV("FA")}>Exportar CSV F.A (mês)</button>
              <button onClick={() => exportCSV("BF")}>Exportar CSV BF (mês)</button>
              <button onClick={() => exportCSV("")}>Exportar CSV Geral (mês)</button>
            </div>

            <p style={{ opacity: 0.75, marginTop: 10 }}>
              Export traz: data, empresa, nome, setor, item, qtd, preço unit, total e user_id (auditoria).
            </p>
          </div>
        )}
      </div>
    </div>
  </div>
);
}
