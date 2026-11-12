'use strict';
const form = document.querySelector('#setup-form');
const message = document.querySelector('#message');
const submit = document.querySelector('#submit');
const token = document.querySelector('#token');
const password = document.querySelector('#password');
const confirm = document.querySelector('#confirm');
function tell(text, error) {
  message.textContent = text;
  message.className = error ? 'error' : 'ok';
}
(async () => {
  try {
    const res = await fetch('/api/v1/auth/status', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const json = await res.json();
    if (json?.data?.passwordConfigured) {
      form.hidden = true;
      tell('A senha já está configurada. Use o link de acesso abaixo.', false);
    }
  } catch {
    tell('Não foi possível consultar o servidor. Verifique a conexão e tente novamente.', true);
  }
})();
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (password.value !== confirm.value) {
    tell('As duas senhas não coincidem.', true);
    return;
  }
  if (password.value.length < 12 || token.value.length < 64) {
    tell('Verifique o token e use uma senha de pelo menos 12 caracteres.', true);
    return;
  }
  submit.disabled = true;
  tell('Configurando proteção do painel...', false);
  try {
    const response = await fetch('/api/v1/auth/password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Bootstrap-Token': token.value,
      },
      body: JSON.stringify({ password: password.value }),
    });
    const result = await response.json();
    if (!response.ok || !result?.success) {
      throw new Error(result?.error?.message || 'Falha ao definir a senha.');
    }
    form.reset();
    tell('Senha configurada! Abrindo o Astra...', false);
    window.location.replace('/');
  } catch (error) {
    tell(error instanceof Error ? error.message : 'Falha ao configurar senha.', true);
    submit.disabled = false;
  }
});
