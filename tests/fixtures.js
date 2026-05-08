'use strict';
// tests/fixtures.js — Anonymised production-like dataset for regression and integration testing.
//
// Source: exported backup (2026-05-08). All PII replaced:
//   - Supplier company names, contacts, emails, phones → fictional
//   - Buyer name and address → fictional
//   - Transaction reference IDs → sequential test refs
//   - B/L number and vessel name → placeholder values
//   - Google Apps Script URL and sync token removed
//
// Entity IDs are opaque timestamp strings preserved from the backup so that all
// cross-references (lid, supId, linkedInvId, invId in payments etc.) remain valid.
//
// Added for regression coverage (not in source backup):
//   CN10001 — credit_note against INV10030, status "CN Applied", cnAmount -500
//   CN10002 — goodwill_credit (no linked invoice), cnAmount -200
//   fixture-gw-pmt-001 — goodwill payments ledger entry for CN10002

module.exports = {

  // ── 9 Suppliers ───────────────────────────────────────────────
  sup: [
    {
      id: 'momz1pkg7kn',
      name: 'Shandong Polyfoam Materials Co., Ltd.',
      country: 'China', ct: 'Lin Wei',
      email: 'sales@polyfoam-materials.example.cn',
      phone: '+86 138 0000 1001', cur: 'USD',
      notes: 'PVC Foam Board. Fire certificate required each shipment. HS Code 3921.90.'
    },
    {
      id: 'momz1pkg5ae',
      name: 'Anhui Greenpack Export Co., Ltd.',
      country: 'China', ct: 'Wang Fang',
      email: 'export@greenpack-anhui.example.cn',
      phone: '+86 138 0000 1002', cur: 'USD',
      notes: 'Onion mesh bags PE. HS Code 6305.33.'
    },
    {
      id: 'momz1pkghir',
      name: 'Shanghai Cooltech Equipment Co., Ltd.',
      country: 'China', ct: 'Chen Mei',
      email: 'sales@cooltech-sh.example.cn',
      phone: '+86 138 0000 1003', cur: 'USD',
      notes: 'Commercial centrifugal juicers. Verify 220V compliance each order.'
    },
    {
      id: 'momz1pkg9ej',
      name: 'Zhengzhou Jucai Machinery Co., Ltd.',
      country: 'China', ct: 'Liu Yang',
      email: 'sales@jucai-machinery.example.cn',
      phone: '+86 138 0000 1004', cur: 'USD',
      notes: 'Commercial sugar cane juicers. Verify 220V each order.'
    },
    {
      id: 'momz1pkgu4i',
      name: 'Xingtai Liheng Machinery Co., Ltd.',
      country: 'China', ct: 'Zhang Peng',
      email: 'sales@liheng-mach.example.cn',
      phone: '+86 138 0000 1005', cur: 'USD',
      notes: 'Manual pallet jacks. HS Code 8427.90.'
    },
    {
      id: 'momz1pkgyjb',
      name: 'Fuzhou Bingxue Equipment Co., Ltd.',
      country: 'China', ct: 'Xu Hong',
      email: 'sales@bingxue-equip.example.cn',
      phone: '+86 138 0000 1006', cur: 'USD',
      notes: 'Commercial freezers, chillers, and cold storage units. 30% deposit / 70% on BL. Lead time 45 days. Verify 220V each order. CE cert required.'
    },
    {
      id: 'momz1pkgxc8',
      name: 'Zhongshan Solaris Lighting Co., Ltd.',
      country: 'China', ct: 'Wu Bo',
      email: 'sales@solaris-lighting.example.cn',
      phone: '+86 138 0000 1007', cur: 'USD',
      notes: 'Solar LED floodlights 200W-1000W.'
    },
    {
      id: 'momz1pkgkts',
      name: 'Changzhou Precitec Weighing Co., Ltd.',
      country: 'China', ct: 'Cao Yan',
      email: 'sales@precitec-weigh.example.cn',
      phone: '+86 138 0000 1008', cur: 'USD',
      notes: 'Platform scales. HS Code 8423.81.'
    },
    {
      id: 'momz1pkgm3d',
      name: 'Secuview (via Trade Portal)',
      country: 'USA', ct: 'Trade Portal',
      email: 'orders@trade-portal.example.com',
      phone: '+1 555 000 0099', cur: 'USD',
      notes: 'Security cameras. US purchase via trade portal. Zero margin pass-through.'
    }
  ],

  // ── 19 Line items ─────────────────────────────────────────────
  li: [
    {
      id: 'momz2ghxkji', sku: 'VF-2050R-F',
      desc: 'VF-2050R Commercial Upright Freezer 3 Door',
      specs: '3 door, commercial upright freezer', hs: '8418.5',
      supId: 'momz1pkgyjb', uom: 'pcs', cost: 2600, price: 3120, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghxu98', sku: 'VF-2050R-C',
      desc: 'VF-2050R Commercial Upright Chiller 3 Door',
      specs: '3 door, commercial upright chiller', hs: '8418.5',
      supId: 'momz1pkgyjb', uom: 'pcs', cost: 1500, price: 1800, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghxlji', sku: '3600LA2Y',
      desc: '3600LA2Y Commercial Upright Freezer 5 Door',
      specs: '5 door, commercial upright freezer', hs: '8418.5',
      supId: 'momz1pkgyjb', uom: 'pcs', cost: 4238, price: 5085.6, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghxs25', sku: 'CS-1',
      desc: 'Cold Storage Unit 7.93x2.44m',
      specs: '7.93x2.44m cold storage room', hs: '8418.69',
      supId: 'momz1pkgyjb', uom: 'pcs', cost: 2300, price: 2760, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6iba', invNum: 'INV10030', date: '2026-03-15' }]
    },
    {
      id: 'momz2ghxeus', sku: 'CS-2',
      desc: 'Cold Storage Unit 5.9x5.3x2.6m',
      specs: '5.9x5.3x2.6m cold storage room', hs: '8418.69',
      supId: 'momz1pkgyjb', uom: 'pcs', cost: 2300, price: 2760, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6iba', invNum: 'INV10030', date: '2026-03-15' }]
    },
    {
      id: 'momz2ghx0ee', sku: 'XINGCHA-PJ',
      desc: 'Manual Pallet Jack 2500kg',
      specs: '2500kg capacity manual pallet jack', hs: '8427.9',
      supId: 'momz1pkgu4i', uom: 'pcs', cost: 630, price: 750, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghx8bc', sku: 'FS-M1212',
      desc: 'FS-M1212 Platform Scale',
      specs: 'FS-M1212 electronic platform scale', hs: '8423.81',
      supId: 'momz1pkgkts', uom: 'pcs', cost: 195, price: 234, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghx5iz', sku: 'PVC-34',
      desc: 'PVC Foam Board 34mm',
      specs: '34mm PVC foam board sheet', hs: '3921.9',
      supId: 'momz1pkg7kn', uom: 'sheets', cost: 25, price: 27.98, cur: 'USD',
      invoiceRefs: [
        { invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' },
        { invId: 'momz2pc6biq', invNum: 'INV10031', date: '2026-03-26' }
      ]
    },
    {
      id: 'momz2ghxf3g', sku: 'PVC-12',
      desc: 'PVC Foam Board 12mm',
      specs: '12mm PVC foam board sheet', hs: '3921.9',
      supId: 'momz1pkg7kn', uom: 'sheets', cost: 12.96, price: 15, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghxhpe', sku: 'PVC-14',
      desc: 'PVC Foam Board 14mm',
      specs: '14mm PVC foam board sheet', hs: '3921.9',
      supId: 'momz1pkg7kn', uom: 'sheets', cost: 7.76, price: 9, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6vgm', invNum: 'INV10028', date: '2026-01-03' }]
    },
    {
      id: 'momz2ghxpoa', sku: 'MESH-ONI-50',
      desc: 'Onion Mesh Bag PE 50cm',
      specs: 'PE onion mesh bag 50cm', hs: '6305.33',
      supId: 'momz1pkg5ae', uom: 'pcs', cost: 0.06, price: 0.07, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6iba', invNum: 'INV10030', date: '2026-03-15' }]
    },
    {
      id: 'momz2ghxh5i', sku: 'BKN-2000',
      desc: 'BKN-2000 Commercial Centrifugal Juicer',
      specs: 'BKN-2000 commercial centrifugal juicer', hs: '8435.1',
      supId: 'momz1pkghir', uom: 'pcs', cost: 290, price: 340, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6iba', invNum: 'INV10030', date: '2026-03-15' }]
    },
    {
      id: 'momz2ghxz7m', sku: 'FADDISH-SCJ',
      desc: 'Faddish Commercial Sugar Cane Juicer',
      specs: 'Faddish commercial sugar cane juicer', hs: '8435.1',
      supId: 'momz1pkg9ej', uom: 'pcs', cost: 330, price: 480, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6iba', invNum: 'INV10030', date: '2026-03-15' }]
    },
    {
      id: 'momz2ghxhtz', sku: 'SOL-200W',
      desc: 'Solar LED Floodlight 200W',
      specs: '200W solar LED floodlight', hs: '9405.4',
      supId: 'momz1pkgxc8', uom: 'pcs', cost: 18.1, price: 21.27, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6biq', invNum: 'INV10031', date: '2026-03-26' }]
    },
    {
      id: 'momz2ghxrtm', sku: 'SOL-400W',
      desc: 'Solar LED Floodlight 400W',
      specs: '400W solar LED floodlight', hs: '9405.4',
      supId: 'momz1pkgxc8', uom: 'pcs', cost: 27.1, price: 31.72, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6biq', invNum: 'INV10031', date: '2026-03-26' }]
    },
    {
      id: 'momz2ghxywf', sku: 'SOL-500W',
      desc: 'Solar LED Floodlight 500W',
      specs: '500W solar LED floodlight', hs: '9405.4',
      supId: 'momz1pkgxc8', uom: 'pcs', cost: 36, price: 41.86, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6biq', invNum: 'INV10031', date: '2026-03-26' }]
    },
    {
      id: 'momz2ghx8o7', sku: 'SOL-1000W',
      desc: 'Solar LED Floodlight 1000W',
      specs: '1000W solar LED floodlight', hs: '9405.4',
      supId: 'momz1pkgxc8', uom: 'pcs', cost: 41.8, price: 48.53, cur: 'USD',
      invoiceRefs: [{ invId: 'momz2pc6biq', invNum: 'INV10031', date: '2026-03-26' }]
    },
    {
      id: 'momz2ghxfhq', sku: 'RLC-540A',
      desc: 'Reolink RLC-540A Security Camera',
      specs: 'RLC-540A outdoor security camera', hs: '8525.8',
      supId: 'momz1pkgm3d', uom: 'pcs', cost: 59.49, price: 59.49, cur: 'USD'
    },
    {
      id: 'momz2ghxzmz', sku: 'RLC-510A',
      desc: 'Reolink RLC-510A Security Camera',
      specs: 'RLC-510A outdoor security camera', hs: '8525.8',
      supId: 'momz1pkgm3d', uom: 'pcs', cost: 104.99, price: 104.99, cur: 'USD'
    },
    {
      id: 'momz2ghx7da', sku: 'RLK16-410B8',
      desc: 'Reolink RLK16-410B8-5MP NVR Kit',
      specs: 'RLK16-410B8-5MP 16-channel NVR security kit', hs: '8525.8',
      supId: 'momz1pkgm3d', uom: 'pcs', cost: 729.99, price: 729.99, cur: 'USD'
    }
  ],

  // ── 5 regular invoices + 2 credit note records ─────────────────
  //
  // INV10028 — Equipment order (Paid). 10 line items: 8 catalogue + freight-as-line + pallets.
  //   live calc: liT≈29957.87, chgs(lf+ins)=1398, grand≈31355.87
  //   ledger dep = 10000 + 21055.87 = 31055.87  →  bal ≈ 300
  //
  // INV10029 — US cameras (Paid). lineItems:[] — uses calc_ fallback.
  //   grand = 957.08, dep = 957.08  →  bal = 0
  //
  // INV10030 — Mixed goods (Partially Paid). 5 live line items.
  //   liT≈13730, chgs(lf)=450, grand≈14180, dep=4000
  //   without CN10001: bal≈10180  |  with CN10001 Applied ($500): bal≈9680
  //
  // INV10031 — PVC board + solar lights (Sent). 6 live line items.
  //   liT≈6842.19, chgs=0, grand≈6842.19, dep=0, bal≈6842.19
  //
  // INV10032 — Freight services (Sent). 4 line items, no lib links, clean integers.
  //   liT=6071, chgs=0, grand=6071, dep=0, bal=6071
  //
  // CN10001 — credit_note against INV10030, CN Applied, cnAmount=-500
  // CN10002 — goodwill_credit, no linked invoice, cnAmount=-200
  inv: [
    {
      id: 'momz2pc6vgm', num: 'INV10028', type: 'invoice',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      shipTo: '', dst: 'Barbados', custId: '',
      date: '2026-01-03', expiry: '2026-01-31', shipDate: '',
      ft: 'Sea - FCL 40HQ', wt: '30000kgs', cbm: '', pk: '17',
      pol: 'Qingdao', pod: 'Bridgetown', coo: 'China',
      cur: 'USD', taxRate: 0,
      lf: 1098, ins: 300, leg: 0, isp: 0, oth: 0, dep: 31055.87,
      incoterm: 'EXW', paymentTerms: 'Net 30',
      terms: 'Payment due within 30 days of invoice date.',
      chargesIncluded: true, status: 'Paid',
      lineItems: [
        { rid: 'movz4umsy76', lid: 'momz2ghxkji', desc: 'VF-2050R Commercial Upright Freezer 3 Door', uom: 'pcs', qty: 1,   up: 3120    },
        { rid: 'movz4unam50', lid: 'momz2ghxu98', desc: 'VF-2050R Commercial Upright Chiller 3 Door', uom: 'pcs', qty: 1,   up: 1800    },
        { rid: 'movz4uncsx4', lid: 'momz2ghxlji', desc: '3600LA2Y Commercial Upright Freezer 5 Door', uom: 'pcs', qty: 1,   up: 5085.6  },
        { rid: 'movz4undf6v', lid: 'momz2ghx0ee', desc: 'Manual Pallet Jack 2500kg',                  uom: 'pcs', qty: 2,   up: 750     },
        { rid: 'movz4unf0i9', lid: 'momz2ghx8bc', desc: 'FS-M1212 Platform Scale',                    uom: 'pcs', qty: 3,   up: 234     },
        { rid: 'movz4unhsrr', lid: 'momz2ghx5iz', desc: 'PVC Foam Board 34mm',                        uom: 'sheets', qty: 200, up: 22   },
        { rid: 'movz4uni5ov', lid: 'momz2ghxf3g', desc: 'PVC Foam Board 12mm',                        uom: 'sheets', qty: 300, up: 15   },
        { rid: 'movz4unk29p', lid: 'momz2ghxhpe', desc: 'PVC Foam Board 14mm',                        uom: 'sheets', qty: 300, up: 9    },
        { rid: 'movz7o3j8mg', lid: '',            desc: 'Qingdao-Bridgetown 40FT HQ container charge', uom: 'lot', qty: 1, up: 5540.07  },
        { rid: 'movzbn5l1xw', lid: '',            desc: 'Pallets x9',                                 uom: 'pcs', qty: 9,   up: 67.8   }
      ],
      pos: [], linkedInvNum: '', linkedInvId: '', cnReason: '', cnAmount: 0
    },
    {
      id: 'momz2pc6eut', num: 'INV10029', type: 'invoice',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      shipTo: '', dst: 'Barbados', custId: '',
      date: '2026-01-03', expiry: '2026-01-31', shipDate: '',
      ft: 'Air', wt: '', cbm: '', pk: '',
      pol: 'Miami', pod: 'Bridgetown', coo: 'USA',
      cur: 'USD', taxRate: 0.07,
      lf: 0, ins: 0, leg: 0, isp: 0, oth: 0, dep: 957.08,
      terms: 'Payment due within 30 days of invoice date.',
      chargesIncluded: true, status: 'Paid',
      lineItems: [], pos: [],
      calc_grandTotal: '957.08', calc_cogs: '894.47',
      calc_grossProfit: '0', calc_netProfit: '0', calc_margin: '0',
      calc_balanceDue: '0', calc_liTotal: '894.47', calc_taxAmt: '62.61',
      linkedInvNum: '', linkedInvId: '', cnReason: '', cnAmount: 0
    },
    {
      id: 'momz2pc6iba', num: 'INV10030', type: 'invoice',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      shipTo: '', dst: 'Barbados', custId: '',
      date: '2026-03-15', expiry: '2026-04-15', shipDate: '',
      ft: 'Sea - FCL 20', wt: '', cbm: '', pk: '7',
      pol: 'Qingdao', pod: 'Bridgetown', coo: 'China',
      cur: 'USD', taxRate: 0,
      lf: 450, ins: 0, leg: 0, isp: 0, oth: 0, dep: 4000,
      incoterm: 'CIF', paymentTerms: 'Net 30',
      terms: 'Payment due within 30 days of invoice date.',
      chargesIncluded: true, status: 'Partially Paid',
      lineItems: [
        { rid: 'mouoc8qlnte', lid: 'momz2ghxpoa', desc: 'Onion Mesh Bag PE 50cm',               uom: 'pcs', qty: 100000, up: 0.0671 },
        { rid: 'mouoc8qnfj8', lid: 'momz2ghxh5i', desc: 'BKN-2000 Commercial Centrifugal Juicer', uom: 'pcs', qty: 3,   up: 340    },
        { rid: 'mouoc8qpsn9', lid: 'momz2ghxz7m', desc: 'Faddish Commercial Sugar Cane Juicer',  uom: 'pcs', qty: 1,   up: 480    },
        { rid: 'mouoka4ud4x', lid: 'momz2ghxs25', desc: 'Cold Storage Unit 7.93x2.44m',          uom: 'pcs', qty: 1,   up: 2760   },
        { rid: 'mouoka510sa', lid: 'momz2ghxeus', desc: 'Cold Storage Unit 5.9x5.3x2.6m',        uom: 'pcs', qty: 1,   up: 2760   }
      ],
      pos: [], linkedInvNum: '', linkedInvId: '', cnReason: '', cnAmount: 0
    },
    {
      id: 'momz2pc6biq', num: 'INV10031', type: 'invoice',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      shipTo: '', dst: 'Barbados', custId: '',
      date: '2026-03-26', expiry: '2026-04-26', shipDate: '2026-05-23',
      ft: 'Sea - FCL 20', wt: '', cbm: '', pk: '4',
      pol: 'Qingdao', pod: 'Bridgetown', coo: 'China',
      cur: 'USD', taxRate: 0,
      lf: 0, ins: 0, leg: 0, isp: 0, oth: 0, dep: 0,
      incoterm: 'EXW', paymentTerms: 'Net 30',
      terms: 'Payment due within 30 days of invoice date.',
      chargesIncluded: true, status: 'Sent',
      lineItems: [
        { rid: 'mow2jmh7s34', lid: 'momz2ghx5iz', desc: 'PVC Foam Board 34mm',          uom: 'sheets', qty: 173, up: 26.13 },
        { rid: 'mow2jmhdz9b', lid: 'momz2ghxhtz', desc: 'Solar LED Floodlight 200W',    uom: 'pcs', qty: 15,    up: 21.27 },
        { rid: 'mow2jmhf0q2', lid: 'momz2ghxrtm', desc: 'Solar LED Floodlight 400W',    uom: 'pcs', qty: 15,    up: 31.72 },
        { rid: 'mow2jmhg5qq', lid: 'momz2ghxywf', desc: 'Solar LED Floodlight 500W',    uom: 'pcs', qty: 15,    up: 41.86 },
        { rid: 'mow2jmhhlo2', lid: 'momz2ghx8o7', desc: 'Solar LED Floodlight 1000W',   uom: 'pcs', qty: 15,    up: 48.53 },
        { rid: 'mow2l8l790d', lid: '',            desc: 'Pallets x3',                   uom: 'pcs', qty: 3,     up: 57    }
      ],
      pos: [], linkedInvNum: '', linkedInvId: '', cnReason: '', cnAmount: 0
    },
    {
      id: 'mox1tlirujm', num: 'INV10032', type: 'invoice',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: '',
      shipTo: '', dst: '', custId: '',
      date: '2026-05-08', expiry: '2026-05-06', shipDate: '',
      ft: '', wt: '', cbm: '', pk: '',
      pol: 'Qingdao (CN QIN)', pod: 'Bridgetown (BB BGI)', coo: 'China',
      cur: 'USD', taxRate: 0,
      lf: 0, ins: 0, leg: 0, isp: 0, oth: 0, dep: 0,
      incoterm: 'FOB', paymentTerms: 'TT in advance',
      terms: 'Payment due within 30 days of invoice date.',
      chargesIncluded: true, status: 'Sent',
      lineItems: [
        { rid: 'mox0x9wp043', lid: '', desc: 'Ocean Freight',     uom: 'lot', qty: 1, up: 4600 },
        { rid: 'mox0xsedt3l', lid: '', desc: 'Customs Clearance', uom: 'lot', qty: 1, up: 124  },
        { rid: 'mox1qtl7lnl', lid: '', desc: 'Local Freight',     uom: 'lot', qty: 1, up: 1085 },
        { rid: 'mox1rjq1its', lid: '', desc: 'Loading Charge',    uom: 'lot', qty: 1, up: 262  }
      ],
      pos: [], linkedInvNum: '', linkedInvId: '', cnReason: '', cnAmount: 0
    },
    // CN10001 — credit note, CN Applied against INV10030, $500
    {
      id: 'fixture-cn-001', num: 'CN10001', type: 'credit_note',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      cur: 'USD', date: '2026-04-01', status: 'CN Applied',
      linkedInvNum: 'INV10030', linkedInvId: 'momz2pc6iba',
      cnAmount: -500, cnReason: 'Price adjustment on delivery batch',
      lineItems: [], pos: [], taxRate: 0, dep: 0,
      lf: 0, ins: 0, leg: 0, isp: 0, oth: 0
    },
    // CN10002 — goodwill credit, no linked invoice, $200
    {
      id: 'fixture-gw-001', num: 'CN10002', type: 'goodwill_credit',
      buyer: 'Carib Fresh Trading Co.', buyerAddr: 'Harbour Road, Bridgetown, Barbados',
      cur: 'USD', date: '2026-04-15', status: 'CN Applied',
      linkedInvNum: '', linkedInvId: '',
      cnAmount: -200, cnReason: 'Compensation for delayed delivery',
      lineItems: [], pos: [], taxRate: 0, dep: 0,
      lf: 0, ins: 0, leg: 0, isp: 0, oth: 0
    }
  ],

  po: [],

  // ── Payments (4 real buyer payments + 1 goodwill ledger entry) ─
  payments: [
    // INV10028 — two-part payment totalling $31,055.87
    {
      id: 'momzrblym5v', invId: 'momz2pc6vgm', invNum: 'INV10028',
      date: '2025-12-30', amount: 10000,    method: 'Bank Transfer',
      reference: 'Ref TXN-2025-0001', notes: 'Part payment', type: 'buyer_payment'
    },
    {
      id: 'momzsoidvhk', invId: 'momz2pc6vgm', invNum: 'INV10028',
      date: '2026-01-29', amount: 21055.87, method: 'Bank Transfer',
      reference: 'Ref TXN-2026-0002', notes: 'Final payment', type: 'buyer_payment'
    },
    // INV10030 — deposit only, $4,000
    {
      id: 'mon013u4nis', invId: 'momz2pc6iba', invNum: 'INV10030',
      date: '2026-04-07', amount: 4000, method: 'Bank Transfer',
      reference: 'Ref TXN-2026-0003', notes: 'Deposit received', type: 'buyer_payment'
    },
    // INV10029 — full payment, $957.08
    {
      id: 'mon03r7vixr', invId: 'momz2pc6eut', invNum: 'INV10029',
      date: '2026-05-01', amount: 957.08, method: 'Bank Transfer',
      reference: 'Ref TXN-2026-0004', notes: 'Full payment', type: 'buyer_payment'
    },
    // CN10002 goodwill — negative ledger entry
    {
      id: 'fixture-gw-pmt-001', invId: 'fixture-gw-001', invNum: 'CN10002',
      amount: -200, method: 'Goodwill Credit', ref: 'CN10002',
      notes: 'Compensation for delayed delivery', date: '2026-04-15'
    }
  ],

  // ── Shipments ─────────────────────────────────────────────────
  sh: [
    {
      id: 'moopnsq2uxh', ref: 'SHP-001',
      blNum: 'BLTEST0000001', vessel: 'TEST VESSEL ALPHA', carrier: 'TEST LINE',
      originPort: 'Qingdao (CN QIN)', destPort: 'Bridgetown (BB BGI)',
      etd: '2026-02-20', eta: '2026-04-12',
      containerType: '40HQ', containerNum: '',
      dg: true, docsStatus: 'Complete', status: 'Delivered',
      linkedInvs: ['INV10028'],
      notes: 'Panama transit complete'
    }
  ],

  qt: []
};
