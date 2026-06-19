// Stackd Ops — Google Apps Script webhook
// Deploy as Web App: Execute as Me, Access: Anyone with the link
// Paste deployment URL into Stackd Ops → Settings → Google Sheets
//
// Before deploying: set the four Script Properties below in
// Apps Script → Project Settings → Script Properties.
// Never put real values for these in source control.

var _props = PropertiesService.getScriptProperties();
var SPREADSHEET_ID          = _props.getProperty('SPREADSHEET_ID');
var TOKEN                   = _props.getProperty('TOKEN');
var REQUIREMENTS_TRACKER_ID = _props.getProperty('REQUIREMENTS_TRACKER_ID');
var PROJECT_TRACKER_ID      = _props.getProperty('PROJECT_TRACKER_ID');
var SHEET_NAMES = {
  sup:       'Suppliers',
  li:        'Line Items',
  inv:       'Invoices',
  po:        'Purchase Orders',
  sh:        'Shipments',
  qt:        'Quotes',
  payments:  'Payments',
  cn:        'Credit Notes',
  inv_lines: 'inv_lines',
  co:        'Contacts'
};

// Expected column headers per entity (display names, matching portal FIELD_MAPS)
var HEADERS = {
  sup:      ['Supplier ID','Name','Country','Contact','Email','Phone','Currency','Payment Terms','Lead Time','DG Capable','Notes'],
  li:       ['SKU','Description','UOM','Unit Cost','Unit Price','Currency','HS Code','Supplier','Notes'],
  inv:      ['Invoice #','Buyer','Buyer Address','Destination','Date','Status','Currency','Grand Total','COGS','Net Profit','Margin','Tax Rate','Local Freight','Balance Due','Incoterms','Port of Loading','Port of Discharge','Notes'],
  cn:       ['CN #','Linked Invoice','Buyer','Date','Status','Credit Amount','Reason','Type','Notes'],
  po:       ['PO #','Supplier','Linked Invoice','Date','Status','Currency','Deposit','Notes'],
  payments: ['Payment ID','Invoice #','Date','Amount','Currency','Method','Notes'],
  sh:       ['Shipment Ref','BL Number','Vessel','Carrier','Origin Port','Dest Port','ETD','ETA','Status','Container Type','Container Number','DG Onboard','Docs Status','Forwarder Name','Forwarder Email','Linked Invoices','Notes'],
  qt:       ['Quote #','Buyer','Date','Status','Currency','Grand Total','Margin','Notes'],
  co:       ['Contact ID','Name','Email','Phone','Company','Status','Source','Enquiry Summary','Notes','Created At','Last Contacted','GDPR Basis']
};

// Business key per entity — used for deduplication and row lookup
var BIZ_KEYS = {
  sup:      'Supplier ID',
  li:       'SKU',
  inv:      'Invoice #',
  cn:       'CN #',
  po:       'PO #',
  payments: 'Payment ID',
  sh:       'Shipment Ref',
  qt:       'Quote #',
  co:       'Contact ID'
};

// REQUIREMENTS_TRACKER_ID and PROJECT_TRACKER_ID are loaded from Script Properties above.

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    if (payload._token !== TOKEN) return respond({ status: 'error', message: 'Unauthorised' });

    var action = payload.action;

    if (action === 'ping')                        return respond(pingResponse());
    if (action === 'bulk_upsert')                 return respond(handleBulkUpsert(payload));
    if (action === 'upsert')                      return respond(handleUpsert(payload));
    if (action === 'delete')                      return respond(handleDelete(payload));
    if (action === 'push_entity')                 return respond(handlePushEntity(payload));
    if (action === 'pull_entity')                 return respond(handlePullEntity(payload));
    if (action === 'update_shipment')             return respond(handleUpdateShipment(payload));
    if (action === 'update_requirements_tracker') return respond(handleTrackerUpdate(payload, REQUIREMENTS_TRACKER_ID, 'Requirements Tracker'));
    if (action === 'update_project_tracker')      return respond(handleTrackerUpdate(payload, PROJECT_TRACKER_ID, 'Project Tracker'));

    return respond({ status: 'error', message: 'Unknown action: ' + action });
  } catch (err) {
    return respond({ status: 'error', message: err.message });
  }
}

// ── bulk_upsert ───────────────────────────────────────────────────
// Receives records with display-header keys (after portal mapRec transform).
// Deduplicates by business key (last-record-wins).
// Logs dedup count to Audit tab if any duplicates found.
// Clears data rows (row 2+) and rewrites with deduplicated records.

function handleBulkUpsert(payload) {
  var entity  = payload.entity;
  var records = payload.records;
  if (!entity)              return { status: 'error', message: 'entity is required' };
  if (!Array.isArray(records)) return { status: 'error', message: 'records must be an array' };

  var sheet = getOrCreateSheet(entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  // Deduplicate by business key (last-record-wins)
  var bizKey = BIZ_KEYS[entity];
  var dedupCount = 0;
  if (bizKey) {
    var seen = {};
    for (var i = 0; i < records.length; i++) {
      var kv = String(records[i][bizKey] || '');
      if (kv) {
        if (seen[kv] !== undefined) dedupCount++;
        seen[kv] = i; // always keep latest index
      }
    }
    if (dedupCount > 0) {
      var includedIdx = {};
      Object.keys(seen).forEach(function(k) { includedIdx[seen[k]] = true; });
      records = records.filter(function(_, idx) { return includedIdx[idx]; });
      logAudit(entity, dedupCount);
    }
  }

  // Ensure header row exists
  var sheetHeaders = ensureHeaders(sheet, entity, records);

  // Clear data rows and rewrite
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  if (records.length === 0) return { status: 'ok', written: 0, deduped: dedupCount };

  var rows = records.map(function(rec) {
    return sheetHeaders.map(function(h) {
      var v = rec[h];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
  });

  sheet.getRange(2, 1, rows.length, sheetHeaders.length).setValues(rows);
  return { status: 'ok', written: records.length, deduped: dedupCount };
}

// ── upsert ────────────────────────────────────────────────────────
// Receives a single record with display-header keys.
// Finds row by business key and updates it; inserts at end if not found.

function handleUpsert(payload) {
  var entity = payload.entity;
  var record = payload.record;
  if (!entity)                           return { status: 'error', message: 'entity is required' };
  if (!record || typeof record !== 'object') return { status: 'error', message: 'record is required' };

  var sheet = getOrCreateSheet(entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  var bizKey = BIZ_KEYS[entity];
  if (!bizKey) return { status: 'error', message: 'No business key defined for: ' + entity };

  var keyVal = String(record[bizKey] || '');
  if (!keyVal) return { status: 'error', message: 'Business key "' + bizKey + '" missing or empty in record' };

  var sheetHeaders = ensureHeaders(sheet, entity, [record]);

  var bizColIdx = sheetHeaders.indexOf(bizKey);
  if (bizColIdx === -1) return { status: 'error', message: 'Business key column "' + bizKey + '" not found in sheet' };

  var row = sheetHeaders.map(function(h) {
    var v = record[h];
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  });

  // Find existing row by business key
  var data = sheet.getDataRange().getValues();
  var rowIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][bizColIdx]) === keyVal) { rowIdx = i + 1; break; }
  }

  if (rowIdx === -1) {
    sheet.appendRow(row);
    return { status: 'ok', action: 'inserted', key: keyVal };
  } else {
    sheet.getRange(rowIdx, 1, 1, row.length).setValues([row]);
    return { status: 'ok', action: 'updated', key: keyVal };
  }
}

// ── delete ────────────────────────────────────────────────────────
// Finds and deletes the row matching the business key value.

function handleDelete(payload) {
  var entity = payload.entity;
  var keyVal = String(payload.keyVal || payload.id || '');
  if (!entity) return { status: 'error', message: 'entity is required' };
  if (!keyVal) return { status: 'error', message: 'keyVal is required' };

  var sheet = getSheet(entity);
  if (!sheet) return { status: 'ok', deleted: false, message: 'Sheet not found for: ' + entity };

  var bizKey = BIZ_KEYS[entity];
  if (!bizKey) return { status: 'error', message: 'No business key defined for: ' + entity };

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return { status: 'ok', deleted: false };

  var headers = data[0].map(String);
  var bizColIdx = headers.indexOf(bizKey);
  if (bizColIdx === -1) return { status: 'error', message: 'Business key column "' + bizKey + '" not found in sheet' };

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][bizColIdx]) === keyVal) {
      sheet.deleteRow(i + 1);
      return { status: 'ok', deleted: true, key: keyVal };
    }
  }
  return { status: 'ok', deleted: false, message: 'Row not found: ' + keyVal };
}

// ── push_entity ───────────────────────────────────────────────────
// Legacy full-replace: clears data rows (row 2+), writes all records.
// Honours whatever headers are already in row 1.

function handlePushEntity(payload) {
  var entity  = payload.entity;
  var records = payload.records;
  if (!entity)              return { status: 'error', message: 'entity is required' };
  if (!Array.isArray(records)) return { status: 'error', message: 'records must be an array' };

  var sheet = getSheet(entity);
  if (!sheet) return { status: 'error', message: 'Unknown entity: ' + entity };

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  if (records.length === 0) return { status: 'ok', written: 0 };

  var headers = Object.keys(records[0]);
  var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String).filter(function(h){ return h !== ''; });
  if (existingHeaders.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    headers = existingHeaders;
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

// ── pull_entity ───────────────────────────────────────────────────
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

// ── update_shipment ───────────────────────────────────────────────
// Finds row by shipmentRef (Shipment Ref column), updates provided fields.

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

// ── tracker update (shared) ───────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────

function getSheet(entity) {
  var name = SHEET_NAMES[entity];
  if (!name) return null;
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(name);
}

function getOrCreateSheet(entity) {
  var name = SHEET_NAMES[entity];
  if (!name) return null;
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  return sheet;
}

// Ensures row 1 headers exist. Returns the header array in use.
function ensureHeaders(sheet, entity, records) {
  var lastCol = sheet.getLastColumn();
  var sheetHeaders;
  if (lastCol === 0) {
    sheetHeaders = HEADERS[entity] || (records.length ? Object.keys(records[0]) : []);
    if (sheetHeaders.length) sheet.getRange(1, 1, 1, sheetHeaders.length).setValues([sheetHeaders]);
  } else {
    sheetHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String).filter(function(h){ return h !== ''; });
    if (!sheetHeaders.length) {
      sheetHeaders = HEADERS[entity] || (records.length ? Object.keys(records[0]) : []);
      if (sheetHeaders.length) sheet.getRange(1, 1, 1, sheetHeaders.length).setValues([sheetHeaders]);
    }
  }
  return sheetHeaders;
}

function logAudit(entity, dedupCount) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var audit = ss.getSheetByName('Audit');
    if (!audit) {
      audit = ss.insertSheet('Audit');
      audit.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Entity', 'Action', 'Details']]);
    }
    audit.appendRow([new Date().toISOString(), entity, 'dedup', dedupCount + ' duplicate(s) removed on bulk_upsert']);
  } catch (e) {}
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function pingResponse() {
  return { status: 'ok', message: 'Stackd Ops Apps Script running', ts: new Date().toISOString() };
}
