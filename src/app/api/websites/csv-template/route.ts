export function GET() {
  const csv = "name,url,client,project,industry,folder,tags,cms\nAcme Store,https://acme.example,Acme Inc,Q3 Retainer,Retail,Retail clients,retail;uk,wordpress\n";
  return new Response(csv, {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="websites-template.csv"' },
  });
}
