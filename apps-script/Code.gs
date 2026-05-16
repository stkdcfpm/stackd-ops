// Stackd Ops — Google Apps Script webhook
// Deploy as Web App: Execute as Me, Access: Anyone with the link
// Paste deployment URL into Stackd Ops → Settings → Google Sheets

var SPREADSHEET_ID = '15nefFkvuPzRl3hN4TOimEvPXpF__NMSYrOFBa0qoqSQ';
var TOKEN          = 'fpm-stackd-2026';

var SHEETS = {
  sup:      'Suppliers',
  li:       'Line Items',
  inv:      'Invoices',
  cn:       'Credit Notes',
  po:       'Purchase Orders',
  payments: 'Payments',
  sh:       'Shipments',
  qt:       'Quotes'
};

var HEADERS = {
  sup:      ['Supplier ID','Name','Country','Contact','Email','Phone','Currency','Payment Terms','Lead Time','DG Capable','Notes'],
  li:       ['SKU','Description','UOM','Unit Cost','Unit Price','Currency','HS Code','Supplier','Length','Width','Height','CBM','DG Flag','Notes'],
  inv:      ['Invoice #','Buyer','Buyer Address','Destination','Date','Status','Currency','Grand Total','COGS','Net Profit','Margin','Tax Rate','Local Freight','Balance Due','Incoterms','Port of Loading','Port of Discharge','Shipment Ref','Notes'],
  cn:       ['CN #','Linked Invoice','Buyer','Date','Status','Credit Amount','Reason','Type','Notes'],
  po:       ['PO #','Supplier','Linked Invoice','Date','Status','Currency','COGS Total','Deposit','Balance Due','Notes'],
  payments: ['Payment ID','Invoice #','Date','Amount','Currency','Method','Notes'],
  sh:       ['Shipment Ref','BL Number','Vessel','Carrier','Origin Port','Dest Port','ETD','ETA','Status','Container Type','Container Number','DG Onboard','Docs Status','Forwarder Name','Forwarder Email','Linked Invoices','Notes'],
  qt:       ['Quote #','Buyer','Date','Status','Currency','Grand Total','Freight','DG Surcharge','Insurance','Duty','Margin','Notes']
};

var REQUIREMENTS_TRACKER_ID = '1q05sSoCMmiqaNNixDWVk2_aJPwEqx37vDbOPNh2gqGw';
var PROJECT_TRACKER_ID      = '1gC6d7ClOFpaocK_lNI685x5yMK5_UHiMgriFlF_UrLg';

// ── helpers ──────────────────────────────────────────────────────

function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(entity) {
  var name = SHEETS[entity];
  if (!name) return null;
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (HEADERS[entity]) sheet.appendRow(HEADERS[entity]);
  }
  return sheet;
}

function pingResponse() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  return {
    status:    'ok',
    message:   'Stackd Ops active',
    sheetId:   ss.getId(),
    sheetName: ss.getName(),
    sheetUrl:  ss.getUrl(),
    tabs:      ss.getSheets().map(function(s){ return s.getName(); })
  };
}

// ── doGet ────────────────────────────────────────────────────────

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var token  = (e && e.parameter && e.parameter._token) || '';
  if (token !== TOKEN) return respond({ status: 'error', message: 'Unauthorised' });
  if (action === 'ping') return respond(pingResponse());
  return respond({ status: 'error', message: 'Unknown GET action' });
}

// ── doPost ───────────────────────────────────────────────────────

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    if (payload._token !== TOKEN) return respond({ status: 'error', message: 'Unauthorised' });

    var action = payload.action;

    if (action === 'ping')                      return respond(pingResponse());
    if (action === 'push_entity')               return respond(handlePushEntity(payload));
    if (action === 'pull_entity')               return respond(handlePullEntity(payload));
    if (action === 'update_shipment')           return respond(handleUpdateShipment(payload));
    if (action === 'update_requirements_tracker') return respond(handleTrackerUpdate(payload, REQUIREMENTS_TRACKER_ID, 'Requirements Tracker'));
    if (action === 'update_project_tracker')    return respond(handleTrackerUpdate(payload, PROJECT_TRACKER_ID, 'Project Tracker'));

    return respond({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return respond({ status: 'error', message: err.message });
  }
}

// ── push_entity ──────────────────────────────────────────────────
// Clears data rows (row 2+), writes all records. Preserves row 1 headers.

function handlePushEntity(payload) {
  var entity  = payload.entity;
  var records = payload.records;
  if (!entity) return { status: 'error', message: 'entity is required' };
  if (!Array.isArray(records)) return { status: 'error', message: 'records must be an array' };

  var sheet = getSheet(entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  // Clear from row 2 down
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();

  if (records.length === 0) return { status: 'ok', written: 0 };

  // Derive column order from first record
  var headers = Object.keys(records[0]);

  // Ensure header row matches — write if sheet was just created empty or keys differ
  var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String).filter(function(h){ return h !== ''; });
  if (existingHeaders.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    headers = existingHeaders; // honour whatever headers are already in row 1
  }

  var rows = records.map(function(rec) {
    return headers.map(function(h) {
      var v = rec[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  });

  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  return { status: 'ok', written: records.length };
}

// ── pull_entity ──────────────────────────────────────────────────
// Reads all data rows. Returns records array.

function handlePullEntity(payload) {
  var entity = payload.entity;
  if (!entity) return { status: 'error', message: 'entity is required' };

  var sheet = getSheet(entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', entity: entity, records: [] };

  var headers = data[0].map(String);
  var records = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var rec = {};
    for (var j = 0; j < headers.length; j++) {
      var v = row[j];
      if (typeof v === 'string' && (v.charAt(0) === '[' || v.charAt(0) === '{')) {
        try { v = JSON.parse(v); } catch (err) {}
      }
      rec[headers[j]] = v;
    }
    records.push(rec);
  }
  return { status: 'ok', entity: entity, records: records };
}

// ── update_shipment ──────────────────────────────────────────────
// Finds row by shipmentRef (column A = 'Shipment Ref'), updates provided fields.

function handleUpdateShipment(payload) {
  if (!payload.shipmentRef) return { status: 'error', message: 'shipmentRef is required' };

  var sheet = getSheet('sh');
  if (!sheet) return { status: 'error', message: 'Shipments sheet not found' };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'error', message: 'Shipment not found' };

  var headers = data[0].map(String);
  var refCol  = headers.indexOf('Shipment Ref');
  if (refCol === -1) return { status: 'error', message: 'Shipments tab missing "Shipment Ref" column' };

  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][refCol]) === String(payload.shipmentRef)) { rowIdx = i; break; }
  }
  if (rowIdx === -1) return { status: 'error', message: 'Shipment not found: ' + payload.shipmentRef };

  var FIELD_MAP = {
    blNum:         'BL Number',
    vessel:        'Vessel',
    carrier:       'Carrier',
    containerNum:  'Container Number',
    containerType: 'Container Type',
    etd:           'ETD',
    eta:           'ETA',
    dg:            'DG Onboard',
    docsStatus:    'Docs Status',
    status:        'Status',
    notes:         'Notes'
  };

  Object.keys(FIELD_MAP).forEach(function(key) {
    if (payload[key] === undefined) return;
    var colIdx = headers.indexOf(FIELD_MAP[key]);
    if (colIdx === -1) return;
    var val = payload[key];
    if (val !== null && val !== undefined && typeof val === 'object') val = JSON.stringify(val);
    sheet.getRange(rowIdx + 1, colIdx + 1).setValue(val);
  });

  return { status: 'ok', success: true, updated: payload.shipmentRef };
}

// ── tracker update (shared) ──────────────────────────────────────
// Payload: { updates: [{ id, field, value }, ...] }

function handleTrackerUpdate(payload, sheetId, sheetName) {
  var updates = payload.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { success: false, error: 'updates array is required and must be non-empty' };
  }

  var ss;
  try {
    ss = SpreadsheetApp.openById(sheetId);
  } catch (err) {
    return { success: false, error: 'Could not open ' + sheetName + ': ' + err.message };
  }

  var sheet = ss.getSheetByName(sheetName) || ss.getSheets()[0];
  if (!sheet) return { success: false, error: 'No sheets found in ' + sheetName };

  var data = sheet.getDataRange().getValues();
  if (data.length < 1) return { success: false, error: sheetName + ' is empty' };

  var headers  = data[0].map(String);
  var idColIdx = headers.indexOf('ID');
  if (idColIdx === -1) idColIdx = 0;

  var rowMap = {};
  for (var i = 1; i < data.length; i++) {
    var rowId = data[i][idColIdx];
    if (rowId !== '' && rowId !== null && rowId !== undefined) rowMap[String(rowId)] = i + 1;
  }

  var updated = [], errors = [];
  updates.forEach(function(u) {
    var rowNum = rowMap[String(u.id)];
    if (!rowNum) { errors.push({ id: u.id, field: u.field, error: 'Row ID ' + u.id + ' not found' }); return; }
    var colIdx = headers.indexOf(u.field);
    if (colIdx === -1) { errors.push({ id: u.id, field: u.field, error: 'Column "' + u.field + '" not found' }); return; }
    sheet.getRange(rowNum, colIdx + 1).setValue(u.value);
    updated.push({ id: u.id, field: u.field });
  });

  if (errors.length && !updated.length) return { success: false, error: errors[0].error, errors: errors };
  var result = { success: true, updated: updated };
  if (errors.length) result.errors = errors;
  return result;
}
