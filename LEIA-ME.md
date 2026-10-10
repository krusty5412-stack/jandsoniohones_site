# Jandson iPhone — site, catálogo, cupons e assistência

## Iniciar localmente

Requer Node.js. No PowerShell, dentro desta pasta:

```powershell
$env:ADMIN_USER = "admin"
$env:ADMIN_PASSWORD = "substitua-por-uma-senha-forte-com-12-ou-mais-caracteres"
node .\server.js
```

Abra `http://localhost:8080`. O painel de chamados fica em `/admin.html`; o painel de produtos e cupons fica em `/admin-gestao.html`. Entre com as credenciais configuradas no terminal. Não use a senha de exemplo. O servidor encerra se as variáveis não estiverem definidas.

Abrir `index.html` por `file://` exibe a página, mas não inicia o servidor e não habilita formulários, catálogo dinâmico ou painéis.

## Gerenciar produtos e imagens

No painel administrativo, escolha **Produtos**, depois **Novo produto**. Cadastre nome, categoria, descrição, preço e disponibilidade confirmados pela loja. A imagem principal é a primeira imagem cadastrada. JPEG, PNG e WebP são aceitos, até 3 MB por arquivo e cinco imagens por produto. A imagem é validada no servidor e armazenada em `uploads/` com nome gerado pelo sistema.

Produtos em rascunho ou desativados não aparecem no catálogo público. Produtos publicados aparecem na página da categoria correspondente. As imagens são removidas do servidor quando deixam de estar vinculadas a algum produto.

## Gerenciar cupons

Na aba **Cupons**, cadastre código, tipo e valor do desconto e, opcionalmente, mínimo de compra, datas, limite total de usos e produtos aplicáveis. Um cupom pode ser publicado, mantido como rascunho ou desativado. O site mostra cupons ativos dentro do período configurado.

O site ainda não tem checkout. A consulta do cupom é informativa: não conclui compra, não contabiliza utilização e não garante que um limite de usos ainda esteja disponível. O cliente precisa confirmar aplicação e condições com a equipe. Não anuncie uma oferta sem validar as regras comerciais da loja.

## Chamados de assistência

Chamados são gravados em `data/tickets.json`; produtos e cupons são gravados em `data/products.json` e `data/coupons.json`. Imagens ficam em `uploads/`. Faça cópias de segurança protegidas desses arquivos e da pasta de imagens.

## Produção

Antes de publicar, use hospedagem com HTTPS e configure `SECURE_COOKIE=true`. Defina usuário e senha fortes e exclusivas no ambiente do servidor. Configure backups, controle de acesso à máquina e política de retenção dos chamados. Revise e complete `politica-privacidade.html` com a razão social, contato de privacidade e procedimentos reais da loja.

O servidor usa Node.js sem dependências adicionais. Em produção, publique atrás de HTTPS e use um proxy reverso/hospedagem administrada. O sistema não inclui pagamento, checkout, estoque sincronizado, cadastro de clientes ou contabilização de resgates de cupons.
