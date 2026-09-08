# Otomatik yayın (isteğe bağlı)

Şu an yayın elle yapılıyor:

```bash
npm run deploy
```

Bu komut testleri çalıştırır, `web/` ve `engine/` klasörlerini birleştirir ve
`gh-pages` dalına gönderir. GitHub Pages o dalı yayınlar.

## Her push'ta otomatik yayına geçmek

`docs/github-pages-workflow.yml` dosyası hazır bir GitHub Actions iş akışıdır:
her push'ta testleri çalıştırır, geçerse siteyi yayınlar.

Kurmak için bir kez şu komutu çalıştırın (GitHub'a `workflow` yetkisi verir):

```bash
gh auth refresh -h github.com -s workflow
```

Sonra:

```bash
mkdir -p .github/workflows
git mv docs/github-pages-workflow.yml .github/workflows/pages.yml
git commit -m "Otomatik yayin is akisi"
git push
```

Son olarak GitHub'da **Settings → Pages → Source** ayarını
*GitHub Actions* yapın (şu an *Deploy from a branch: gh-pages*).
