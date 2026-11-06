export function priceOrder(cart, products, promotions) {
  const available = new Map(products.map(p => [p.id, p]));
  const lines = cart.map(item => {
    const p = available.get(item.id);
    if (!p || !Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 10000 || !Number.isSafeInteger(p.price) || p.price < 1) throw Error('商品或數量不正確');
    return {id:item.id,qty:item.qty,price:p.price,gross:item.qty*p.price,discount:0};
  });
  if(lines.length > 20 || new Set(lines.map(x=>x.id)).size!==lines.length) throw Error('單次最多結算 20 種不同商品');
  const remaining = new Map(lines.map(line => [line.id, line.qty]));
  const byId = new Map(lines.map(line => [line.id, line]));
  const applied=[];
  const validPromos = [...promotions].filter(p=>p.enabled && p.productA!==p.productB && ['addOn'].includes(p.kind)).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  for(const promo of validPromos){
    const a=byId.get(promo.productA), b=byId.get(promo.productB);
    if(!a||!b)continue;
    const count=Math.min(remaining.get(a.id)||0, remaining.get(b.id)||0);
    if(!count)continue;
    const pairBase=a.price+b.price;
    let pairTotal;
    if(!Number.isSafeInteger(promo.value)||promo.value<0||promo.value>b.price)continue;
    pairTotal=a.price+promo.value;
    const perPairSaving=pairBase-pairTotal;
    if(perPairSaving<=0)continue;
    const aReduction=Math.floor(perPairSaving*a.price/pairBase);
    a.discount+=aReduction*count;
    b.discount+=(perPairSaving-aReduction)*count;
    remaining.set(a.id,remaining.get(a.id)-count);
    remaining.set(b.id,remaining.get(b.id)-count);
    applied.push({id:promo.id,name:promo.name,count,saved:perPairSaving*count,kind:promo.kind});
  }
  const subtotal=lines.reduce((sum,x)=>sum+x.gross,0), discount=lines.reduce((sum,x)=>sum+x.discount,0);
  if(!Number.isSafeInteger(subtotal)||!Number.isSafeInteger(discount))throw Error('金額超過上限');
  return {subtotal,discount,total:subtotal-discount,lines:lines.map(x=>({...x,lineTotal:x.gross-x.discount})),applied};
}
