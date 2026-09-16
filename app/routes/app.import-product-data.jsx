import { useState, useEffect, useRef } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import ExcelJS from "exceljs";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Pagination, ProgressBar } from "@shopify/polaris";

const getCellValue = (cell) => {
    const value = cell?.value;

    if (value === undefined || value === null) return "";
    if (typeof value === "object") {
        if (value.text) return value.text;
        if (value.result !== undefined) return value.result;
        if (value.richText) return value.richText.map((part) => part.text).join("");
    }

    return value;
};

const rowsFromWorksheet = (worksheet) => {
    const jsonData = [];
    const headers = [];

    worksheet.getRow(1).eachCell((cell, colNumber) => {
       headers[colNumber] = cell.value ? String(getCellValue(cell)).trim() : "";
    });

    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            const rowData = {};
            row.eachCell((cell, colNumber) => {
                if (headers[colNumber]) rowData[headers[colNumber]] = getCellValue(cell);
            });
            if (rowData["SKU"] && String(rowData["SKU"]).trim() !== "") {
                jsonData.push(rowData);
            }
        }
    });

    return { rows: jsonData, headers: headers.filter(Boolean) };
};

const parseCsvText = (text) => {
    const rows = [];
    let currentRow = [];
    let currentCell = "";
    let inQuotes = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const nextChar = text[index + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
            currentCell += '"';
            index++;
        } else if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === "," && !inQuotes) {
            currentRow.push(currentCell);
            currentCell = "";
        } else if ((char === "\n" || char === "\r") && !inQuotes) {
            if (char === "\r" && nextChar === "\n") index++;
            currentRow.push(currentCell);
            rows.push(currentRow);
            currentRow = [];
            currentCell = "";
        } else {
            currentCell += char;
        }
    }

    currentRow.push(currentCell);
    rows.push(currentRow);

    const headers = (rows.shift() || []).map((header) => String(header || "").trim());
    const jsonData = rows
        .map((row) => {
            const rowData = {};
            headers.forEach((header, index) => {
                if (header) rowData[header] = row[index] || "";
            });
            return rowData;
        })
        .filter((row) => row["SKU"] && String(row["SKU"]).trim() !== "");

    return { rows: jsonData, headers: headers.filter(Boolean) };
};

const tableColumns = (row) => {
    const preferred = [
        "SKU",
        "Inventory Location",
        "Current Quantity",
        "New Quantity",
        "Quantity Change",
        "Status",
        "Reason",
        "Error Reason"
    ];
    const keys = Object.keys(row || {});
    return [
        ...preferred.filter((key) => keys.includes(key)),
        ...keys.filter((key) => !preferred.includes(key))
    ];
};

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const url = new URL(request.url);
    const checkStatus = url.searchParams.get("checkStatus");
    const operationId = url.searchParams.get("operationId");

    // --- POLLING LOGIC ---
    if (checkStatus === "true" && operationId) {
        const response = await admin.graphql(
            `#graphql
            query($id: ID!) {
                node(id: $id) {
                    ... on BulkOperation {
                        id
                        status
                        objectCount
                        url
                    }
                }
            }`,
            { variables: { id: operationId } }
        );

        const data = await response.json();
        const bulkOperation = data.data?.node;

        if (!bulkOperation) {
            return { success: false, status: "NONE", operationId };
        }

        if (bulkOperation.status === "COMPLETED") {
             // Check result file for userErrors
             let bulkErrors = [];
             let successCount = 0;
             
             if (bulkOperation.url) {
                try {
                    const fileResponse = await fetch(bulkOperation.url);
                    const text = await fileResponse.text();
                    const lines = text.split("\n").filter(line => line.trim() !== "");
                    lines.forEach(line => {
                        const result = JSON.parse(line);
                        const userErrors = result.inventorySetQuantities?.userErrors || [];
                        if (userErrors.length > 0) {
                             bulkErrors.push(userErrors[0].message);
                        } else {
                             successCount++;
                        }
                    });
                } catch (e) {
                    console.error("Error parsing bulk result", e);
                }
             } else {
                 successCount = parseInt(bulkOperation.objectCount) || 0;
             }
             // Explicitly return operationId for frontend validation
             return { success: true, status: "COMPLETED", bulkResults: { updated: successCount, errors: bulkErrors }, operationId };

        } else if (bulkOperation.status === "RUNNING" || bulkOperation.status === "CREATED") {
             return { success: true, status: "RUNNING", progress: bulkOperation.objectCount, operationId };
        } else {
             return { success: false, status: bulkOperation.status, operationId };
        }
    }

    // --- INITIAL DATA ---
    const response = await admin.graphql(
        `#graphql
        query getLocations {
            locations(first: 250, includeLegacy: true, includeInactive: true) {
                edges {
                    node {
                        id
                        name
                        isActive
                    }
                }
            }
        }`
    );

    const data = await response.json();
    const locations = data.data?.locations?.edges.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
        isActive: edge.node.isActive
    })) || [];

    return { locations };
};

export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const dataString = formData.get("data");
    const locationId = formData.get("locationId");
    const dryRun = formData.get("dryRun") === "true";
    const rows = JSON.parse(dataString);

    const results = {
        total: rows.length,
        updated: 0, 
        dryRun,
        errors: [],
        failedRows: [],
        skippedRows: [],
        updatedRows: [],
        rollbackRows: [],
        counts: {
            matched: 0,
            updated: 0,
            unchanged: 0,
            failed: 0,
            missingSku: 0,
            missingShopifySku: 0,
            invalidQuantity: 0,
            duplicate: 0
        },
        bulkOperationId: null
    };

    if (!locationId || locationId === "SELECT_LOCATION") {
        results.errors.push("Choose an inventory location before importing.");
        results.failedRows = rows.map((row) => ({ ...row, "Status": "Failed", "Error Reason": "Missing inventory location" }));
        results.counts.failed = results.failedRows.length;
        return { success: true, results };
    }

    const isAllLocationsMode = locationId === "ALL_LOCATIONS";

    // 1. HELPER: Fetch All Locations
    let allLocations = [];
    if (isAllLocationsMode) {
        const locationsQuery = await admin.graphql(
            `#graphql
            query getLocations {
                locations(first: 250, includeLegacy: true, includeInactive: true) {
                    edges { node { id name } }
                }
            }`
        );
        const locationsResult = await locationsQuery.json();
        allLocations = locationsResult.data?.locations?.edges.map(edge => ({
            id: edge.node.id,
            name: edge.node.name
        })) || [];
    }

    // 2. HELPER: Get Selected Location Name
    let selectedLocationName = null;
    if (!isAllLocationsMode) {
        const locationQuery = await admin.graphql(
            `#graphql
            query getLocation($id: ID!) {
                location(id: $id) { name }
            }`,
            { variables: { id: locationId } }
        );
        const locationResult = await locationQuery.json();
        selectedLocationName = locationResult.data?.location?.name;
    }

    // 3. OPTIMIZATION: Prefetch All Variants & Inventory Levels (Global Fetch)
    
    let skuMap = new Map(); // SKU -> { inventoryItemId, levels: Map<LocationId, Qty> }
    
    let hasNextPage = true;
    let endCursor = null;

    console.log("Prefetching inventory data...");
    while (hasNextPage) {
        const query = `#graphql
        query getInventoryData($after: String) {
            productVariants(first: 250, after: $after) {
                pageInfo { hasNextPage endCursor }
                edges {
                    node {
                        sku
                        inventoryItem {
                            id
                            inventoryLevels(first: 50) {
                                edges {
                                    node {
                                        location { id }
                                        quantities(names: ["available"]) { quantity name }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }`;
        
        const res = await admin.graphql(query, { variables: { after: endCursor } });
        const data = await res.json();
        
        data.data?.productVariants?.edges.forEach(edge => {
            const node = edge.node;
            if (node.sku) {
                const levels = new Map();
                node.inventoryItem?.inventoryLevels?.edges.forEach(lvl => {
                     const qtyNode = lvl.node.quantities.find(q => q.name === "available");
                     if (qtyNode) levels.set(lvl.node.location.id, qtyNode.quantity);
                });
                
                skuMap.set(node.sku.toLowerCase(), {
                    inventoryItemId: node.inventoryItem.id,
                    levels: levels
                });
            }
        });
        
        hasNextPage = data.data?.productVariants?.pageInfo?.hasNextPage;
        endCursor = data.data?.productVariants?.pageInfo?.endCursor;
    }
    console.log(`Prefetched ${skuMap.size} variants.`);

    // 4. PROCESS ROWS (In-Memory Validation)
    const processedCombinations = new Set();
    const bulkUpdates = []; 

    for (const row of rows) {
        try {
            if (!row["SKU"] || row["SKU"] === "SKU") {
                results.counts.missingSku++;
                continue;
            }

            const sku = String(row["SKU"]).trim(); // Keep original for display
            const skuKey = sku.toLowerCase();     // Lowercase for matching
            const quantityRaw = row["Quantity Available"];
            const quantity = parseInt(quantityRaw);

            if (isNaN(quantity) || quantity === null || quantity === undefined) {
                results.counts.invalidQuantity++;
                results.errors.push(`Skipped SKU ${sku}: Invalid or missing quantity value`);
                results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": 'Invalid or missing quantity value' });
                continue;
            }

            const sheetLocationRaw = row["Inventory Location"];
            const sheetLocation = sheetLocationRaw ? String(sheetLocationRaw).trim() : "";

            let targetLocationId = locationId;
            let targetLocationName = selectedLocationName;

            if (isAllLocationsMode) {
                if (!sheetLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Inventory Location is required when "All Locations" is selected`);
                    results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": 'Inventory Location is required for All Locations mode' });
                    continue;
                }
                const foundLocation = allLocations.find(loc => loc.name.toLowerCase() === sheetLocation.toLowerCase());
                if (!foundLocation) {
                    results.errors.push(`Skipped SKU ${sku}: Location '${sheetLocation}' not found in store`);
                    results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": `Location '${sheetLocation}' not found in store` });
                    continue;
                }
                targetLocationId = foundLocation.id;
                targetLocationName = foundLocation.name;
            } else {
                 if (sheetLocation && sheetLocation.toLowerCase() !== selectedLocationName.toLowerCase()) {
                    results.errors.push(`Skipped SKU ${sku}: Location in sheet '${sheetLocation}' does not match selected location '${selectedLocationName}'`);
                    results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": `Location mismatch: '${sheetLocation}' does not match '${selectedLocationName}'` });
                    continue;
                }
            }

            const combinationKey = `${skuKey}|${targetLocationName}`;
            if (processedCombinations.has(combinationKey)) {
                results.counts.duplicate++;
                results.errors.push(`Skipped SKU ${sku}: You have identical row having same SKU and location`);
                results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": 'Duplicate SKU and location in file' });
                continue;
            }
            processedCombinations.add(combinationKey);

            // --- LOOKUP & VALIDATION (In-Memory) ---
            const variantData = skuMap.get(skuKey);
            
            if (!variantData) {
                results.counts.missingShopifySku++;
                results.errors.push(`Variant not found for SKU: ${sku}`);
                results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": 'Variant not found' });
                continue;
            }

            const currentQty = variantData.levels.get(targetLocationId);
            
            if (currentQty === undefined) {
                 // Try to be more lenient? If undefined, we can't update via 'inventorySetQuantities' easily
                 // unless we are sure. But let's stick to skipping for safety.
                 results.errors.push(`Skipped SKU ${sku}: SKU don't have this location (or not stocked)`);
                 results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": `SKU does not have this location` });
                 continue;
            }

            results.counts.matched++;

            if (currentQty === quantity) {
                results.counts.unchanged++;
                results.skippedRows.push({
                    ...row,
                    "Status": "Skipped",
                    "Current Quantity": currentQty,
                    "New Quantity": quantity,
                    "Quantity Change": 0,
                    "Reason": 'Quantity already matches'
                });
                continue;
            }

            // Valid Update! Add to queue.
            results.updatedRows.push({
                ...row,
                "Status": dryRun ? "Ready" : "Submitted",
                "Inventory Location": targetLocationName,
                "Current Quantity": currentQty,
                "New Quantity": quantity,
                "Quantity Change": quantity - currentQty,
                "Reason": "Inventory quantity update"
            });
            results.rollbackRows.push({
                SKU: sku,
                "Inventory Location": targetLocationName,
                "Quantity Available": currentQty,
                "Rollback Reason": "Restore quantity before inventory import"
            });
            bulkUpdates.push({
                inventoryItemId: variantData.inventoryItemId,
                locationId: targetLocationId,
                quantity: quantity
            });

        } catch (error) {
            results.errors.push(`Error processing SKU ${row["SKU"]}: ${error.message}`);
            results.failedRows.push({ ...row, "Status": "Failed", "Error Reason": error.message });
        }
    }

    console.log(`Validation complete. Bulk Updates Queue: ${bulkUpdates.length}`);
    results.updated = dryRun ? 0 : results.updated;
    results.counts.updated = bulkUpdates.length;
    results.counts.failed = results.failedRows.length;

    if (dryRun) {
        results.expectedUpdateCount = bulkUpdates.length;
        return { success: true, results };
    }

    // 5. EXECUTE UPDATES (Bulk vs Immediate)
    
    if (bulkUpdates.length === 0) {
        return { success: true, results };
    }

    // Prepare JSONL for Bulk
    const jsonlLines = [];
    let currentBatch = [];
    const BATCH_SIZE = 1; // 1 mutation per row for accurate counting and granular error reporting
    
    for (const update of bulkUpdates) {
        currentBatch.push(update);
        if (currentBatch.length >= BATCH_SIZE) {
            jsonlLines.push(JSON.stringify({
                input: {
                    reason: "correction",
                    name: "available",
                    ignoreCompareQuantity: true,
                    quantities: currentBatch
                }
            }));
            currentBatch = [];
        }
    }
    if (currentBatch.length > 0) {
        jsonlLines.push(JSON.stringify({
            input: {
                reason: "correction",
                name: "available",
                ignoreCompareQuantity: true,
                quantities: currentBatch
            }
        }));
    }

    const { stagedUploadsCreate, userErrors: stageErrors } = await (await admin.graphql(`#graphql
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
        }
    }`, {
        variables: {
            input: [{
                filename: "updates.jsonl",
                mimeType: "text/jsonl",
                httpMethod: "POST",
                resource: "BULK_MUTATION_VARIABLES"
            }]
        }
    })).json().then(r => r.data || {});

    if (stageErrors?.length > 0 || stagedUploadsCreate?.userErrors?.length > 0) {
        const msg = stageErrors?.[0]?.message || stagedUploadsCreate?.userErrors?.[0]?.message;
        results.errors.push("Failed to create upload target: " + msg);
        return { success: true, results };
    }

    const target = stagedUploadsCreate?.stagedTargets?.[0];
    if (target) {
        const formData = new FormData();
        const keyParam = target.parameters.find(p => p.name === "key");
        const uploadPath = keyParam?.value; // Use the 'key' as the path

        target.parameters.forEach(p => formData.append(p.name, p.value));
        formData.append("file", new Blob([jsonlLines.join("\n")], { type: "text/jsonl" }));

        const uploadRes = await fetch(target.url, { method: "POST", body: formData });
        if (!uploadRes.ok) {
             results.errors.push(`Upload failed: ${uploadRes.statusText}`);
             return { success: true, results };
        }

        const bulkRes = await admin.graphql(`#graphql
        mutation bulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
            bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
                bulkOperation { id }
                userErrors { field message }
            }
        }`, {
            variables: {
                mutation: `mutation call($input: InventorySetQuantitiesInput!) {
                    inventorySetQuantities(input: $input) {
                        inventoryAdjustmentGroup { id }
                        userErrors { field message }
                    }
                }`,
                stagedUploadPath: uploadPath // Key is safer than resourceUrl
            }
        });
        
        const bulkData = await bulkRes.json();
        if (bulkData.data?.bulkOperationRunMutation?.userErrors?.length > 0) {
             results.errors.push("Bulk Mutation Error: " + bulkData.data.bulkOperationRunMutation.userErrors[0].message);
        } else {
             const opId = bulkData.data?.bulkOperationRunMutation?.bulkOperation?.id;
             console.log("Bulk Op Started:", opId, "Upload Key:", uploadPath);
             
             if (opId) {
                 results.bulkOperationId = opId;
             } else {
                 results.errors.push("Failed to trigger backend bulk operation (No ID returned)");
             }
        }
    } else {
        results.errors.push("Failed to get upload target URL");
    }

    return { success: true, results };
};

export default function ImportProductData() {
    const shopify = useAppBridge();
    const fetcher = useFetcher();
    const loaderFetcher = useFetcher();
    const pollFetcher = useFetcher(); 

    const [isStylesLoaded, setIsStylesLoaded] = useState(false);

    useEffect(() => {
        const timer = setTimeout(() => {
            setIsStylesLoaded(true);
        }, 100);
        return () => clearTimeout(timer);
    }, []);
    
    const [file, setFile] = useState(null);
    const [sourceName, setSourceName] = useState("");
    const [parsedData, setParsedData] = useState(null);
    const [headers, setHeaders] = useState([]);
    const [selectedLocation, setSelectedLocation] = useState("SELECT_LOCATION");
    const [progress, setProgress] = useState(0);
    const [isProgressVisible, setIsProgressVisible] = useState(false);
    const fileInputRef = useRef(null);

    // Initial Results (from immediate validation)
    const [validatedResults, setValidatedResults] = useState(null);
    // Final Results (merged with bulk)
    const [finalResults, setFinalResults] = useState(null);

    const [failedPage, setFailedPage] = useState(1);
    const failedRowsPerPage = 10;
    const [skippedPage, setSkippedPage] = useState(1);
    const skippedRowsPerPage = 10;
    const [updatedPage, setUpdatedPage] = useState(1);
    const updatedRowsPerPage = 10;

    const isLoading = fetcher.state === "submitting" || fetcher.state === "loading";
    const locations = loaderFetcher.data?.locations || [];
    const isUpdatingShopify = !!validatedResults?.bulkOperationId && !finalResults;
    const canPreview = parsedData?.length > 0 && selectedLocation && selectedLocation !== "SELECT_LOCATION";

    useEffect(() => {
        loaderFetcher.load("/app/import-product-data");
    }, []);

    const submitImport = (isDryRun) => {
        if (!canPreview) {
            shopify.toast.show("Choose a location and load an inventory file first.", { duration: 5000 });
            return;
        }

        setFailedPage(1);
        setSkippedPage(1);
        setUpdatedPage(1);
        setValidatedResults(null);
        setFinalResults(null);
        setIsProgressVisible(true);
        setProgress(isDryRun ? 15 : 10);
        fetcher.submit({
            data: JSON.stringify(parsedData),
            locationId: selectedLocation,
            dryRun: isDryRun ? "true" : "false"
        }, { method: "POST" });
    };

    const handleFileChange = (e) => {
        const selectedFile = e.target.files[0];
        if (selectedFile) {
            setFile(selectedFile);
            setSourceName(selectedFile.name);
            setFailedPage(1);
            setSkippedPage(1);
            setUpdatedPage(1);
            setValidatedResults(null); 
            setFinalResults(null);

            // CLEAR INPUT so same file can be selected again
            e.target.value = ""; 

            const reader = new FileReader();
            reader.onload = async (event) => {
                const isCsv = selectedFile.name.toLowerCase().endsWith(".csv");
                let parsedWorkbook;

                if (isCsv) {
                    parsedWorkbook = parseCsvText(event.target.result);
                } else {
                    const workbook = new ExcelJS.Workbook();
                    await workbook.xlsx.load(event.target.result);
                    parsedWorkbook = rowsFromWorksheet(workbook.worksheets[0]);
                }

                setParsedData(parsedWorkbook.rows);
                setHeaders(parsedWorkbook.headers);
                shopify.toast.show(`File loaded: ${parsedWorkbook.rows.length} rows. Preview before updating Shopify.`, { duration: 5000 });
            };
            if (selectedFile.name.toLowerCase().endsWith(".csv")) {
                reader.readAsText(selectedFile);
            } else {
                reader.readAsArrayBuffer(selectedFile);
            }
        }
    };

    const handleButtonClick = () => {
        if (!selectedLocation || selectedLocation === "SELECT_LOCATION") {
             shopify.toast.show("Please select a location first", { duration: 5000 });
             return;
        }
        if (fileInputRef.current) fileInputRef.current.click();
    };

    // --- HANDLE ACTION RESPONSE ---
    useEffect(() => {
        if (fetcher.data?.success && fetcher.state === "idle") {
            const res = fetcher.data.results;
            setValidatedResults(res);

            if (res.dryRun) {
                setFinalResults(null);
                setProgress(100);
                setTimeout(() => setIsProgressVisible(false), 800);
                shopify.toast.show(`Preview ready. ${res.updatedRows?.length || 0} rows can be updated.`, { duration: 5000 });
            } else if (res.bulkOperationId) {
                // Bulk job started for the updates!
                pollFetcher.load(`/app/import-product-data?checkStatus=true&operationId=${res.bulkOperationId}`);
            } else {
                // No bulk job (either 0 updates or error).
                setFinalResults(res); 
                setProgress(100);
                setTimeout(() => setIsProgressVisible(false), 2000);
                shopify.toast.show(`Import complete.`, { duration: 5000 });
            }
        }
    }, [fetcher.data, fetcher.state]);

    // --- POLLING ---
    useEffect(() => {
        if (validatedResults?.bulkOperationId) {
             const opId = validatedResults.bulkOperationId;
             if (pollFetcher.data && pollFetcher.data.operationId) {
                  // CHECK ID MATCH to avoid stale data
                  if (pollFetcher.data.operationId !== opId) return;

                  if (pollFetcher.data.status === "RUNNING" || pollFetcher.data.status === "CREATED") {
                       // Keep polling
                       const timer = setTimeout(() => {
                           pollFetcher.load(`/app/import-product-data?checkStatus=true&operationId=${opId}`);
                       }, 2000);
                       return () => clearTimeout(timer);
                  } else if (pollFetcher.data.status === "COMPLETED") {
                       // Merge results!
                       const bulkRes = pollFetcher.data.bulkResults || { updated: 0, errors: [] };
                       
                       const merged = {
                           ...validatedResults,
                           updated: validatedResults.updated + bulkRes.updated, 
                           errors: [...validatedResults.errors, ...bulkRes.errors]
                       };
                       setFinalResults(merged);
                       setProgress(100);
                       shopify.toast.show(`Import complete. ${merged.updated} updated.`, { duration: 5000 });
                       setTimeout(() => setIsProgressVisible(false), 2000);
                  } else if (pollFetcher.data.status === "FAILED") {
                       shopify.toast.show("Background update failed.", { duration: 5000 });
                       setIsProgressVisible(false);
                  }
             }
        }
    }, [pollFetcher.data, validatedResults]);

    // --- PROGRESS UI ---
    useEffect(() => {
        if (isLoading) {
             // Analysis Phase: Fast start, then smooth crawl
             const interval = setInterval(() => {
                setProgress((prev) => {
                    if (prev < 30) return prev + 2;
                    if (prev < 60) return prev + 0.5;
                    if (prev < 90) return prev + 0.05;
                    return prev;
                });
            }, 100);
            return () => clearInterval(interval);
        } else if (validatedResults?.bulkOperationId && !finalResults) {
             // Bulk Processing Phase (Polling)
             const interval = setInterval(() => {
                setProgress((prev) => {
                     if (prev < 80) return prev + 1;
                     if (prev < 95) return prev + 0.1; 
                     return prev;
                });
            }, 500);
            return () => clearInterval(interval);
        }
    }, [isLoading, validatedResults, finalResults]);

    const downloadRowsWorkbook = async (filename, sheets) => {
        const workbook = new ExcelJS.Workbook();

        Object.entries(sheets).forEach(([sheetName, rows]) => {
            if (!rows?.length) return;
            const worksheet = workbook.addWorksheet(sheetName.slice(0, 31));
            const columns = tableColumns(rows[0]);
            worksheet.addRow(columns);
            rows.forEach((row) => worksheet.addRow(columns.map((column) => row[column] ?? "")));
            worksheet.columns.forEach((column) => {
                column.width = Math.min(42, Math.max(14, ...column.values.map((value) => String(value || "").length + 2)));
            });
        });

        if (workbook.worksheets.length === 0) {
            shopify.toast.show("There are no rows to download yet.", { duration: 5000 });
            return;
        }

        const buffer = await workbook.xlsx.writeBuffer();
        const blobUrl = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(blobUrl);
    };

    const downloadImportTemplate = () => {
        downloadRowsWorkbook("inventory-import-template.xlsx", {
            "Inventory Import Template": [
                {
                    "SKU": "ABC-123",
                    "Inventory Location": selectedLocation === "ALL_LOCATIONS" ? "Main Warehouse" : "",
                    "Quantity Available": 25,
                    "Notes": selectedLocation === "ALL_LOCATIONS"
                        ? "Inventory Location is required when importing all locations"
                        : "Inventory Location can be blank for a single selected location"
                }
            ]
        });
    };

    const downloadResultReport = () => {
        if (!displayResults) return;
        downloadRowsWorkbook("inventory-update-report.xlsx", {
            "Updated": displayResults.updatedRows,
            "Failed": displayResults.failedRows,
            "Skipped": displayResults.skippedRows
        });
    };

    const downloadRollbackFile = () => {
        if (!displayResults?.rollbackRows?.length) {
            shopify.toast.show("Preview changes first to create a rollback file.", { duration: 5000 });
            return;
        }
        downloadRowsWorkbook("inventory-update-rollback.xlsx", {
            "Rollback": displayResults.rollbackRows
        });
    };

    const displayResults = finalResults || validatedResults;
    const selectedFileName = sourceName || file?.name || "No source selected";
    const sampleHeaders = headers.slice(0, 6);
    const sampleRows = parsedData?.slice(0, 3) || [];

    if (!isStylesLoaded) {
        return null; // Or return a loading spinner / skeleton
    }

    return (
        <s-page heading="Import Product Inventory Data" inlineSize="large">
            <div className="page-frame">
                <div className="workflow-strip">
                    <div className={`workflow-step ${selectedLocation !== "SELECT_LOCATION" ? "is-complete" : "is-active"}`}>
                        <span>1</span>
                        <strong>Select location</strong>
                    </div>
                    <div className={`workflow-step ${parsedData?.length > 0 ? "is-complete" : selectedLocation !== "SELECT_LOCATION" ? "is-active" : ""}`}>
                        <span>2</span>
                        <strong>Load file</strong>
                    </div>
                    <div className={`workflow-step ${displayResults?.dryRun ? "is-active" : ""}`}>
                        <span>3</span>
                        <strong>Preview</strong>
                    </div>
                    <div className={`workflow-step ${finalResults ? "is-complete" : ""}`}>
                        <span>4</span>
                        <strong>Update</strong>
                    </div>
                </div>

                <div className="app-layout-with-aside">
                    <div className="primary-workspace">
                        <s-section heading="Load Inventory Source">
                            <div className="source-panel">
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    onChange={handleFileChange}
                                    style={{ display: 'none' }}
                                />
                                <div className="source-copy">
                                    <p className="panel-title">Excel or CSV inventory workbook</p>
                                    <p className="panel-copy">Choose a Shopify location, load a file with SKU and Quantity Available columns, preview the changes, then update Shopify.</p>
                                    <div className="file-meta">
                                        <span>{selectedFileName}</span>
                                        {parsedData?.length > 0 && <span>{parsedData.length} rows loaded</span>}
                                        {headers.length > 0 && <span>{headers.length} columns found</span>}
                                    </div>
                                </div>
                                <div className="source-actions">
                                    <s-select
                                        label="Choose Location"
                                        value={selectedLocation}
                                        onChange={(e) => setSelectedLocation(e.target.value)}
                                    >
                                        <s-option value="SELECT_LOCATION" disabled>- Select -</s-option>
                                        <s-option value="ALL_LOCATIONS">All Locations</s-option>
                                        <s-option-group label="Available Store Locations">
                                            {locations.map((location) => (
                                                <s-option key={location.id} value={location.id}>
                                                    {location.name}
                                                </s-option>
                                            ))}
                                        </s-option-group>
                                    </s-select>
                                    <div className="button-row compact-row">
                                        <s-button
                                            variant="primary"
                                            onClick={handleButtonClick}
                                            loading={(isLoading || isUpdatingShopify) ? "true" : undefined}
                                            disabled={selectedLocation === "SELECT_LOCATION" ? "true" : undefined}
                                        >
                                            Choose File
                                        </s-button>
                                        <s-button onClick={downloadImportTemplate}>
                                            Download Template
                                        </s-button>
                                    </div>
                                </div>
                            </div>
                            {selectedLocation === "ALL_LOCATIONS" && (
                                <div className="section-note warning-note">
                                    <strong>Inventory Location column required.</strong> All Locations mode uses the location name in each row to decide where each SKU should be updated.
                                </div>
                            )}
                        </s-section>

                        {parsedData?.length > 0 && (
                            <div className="section-gap">
                                <s-section heading="Preview Inventory Changes">
                                    <div className="status-strip">
                                        <span>{headers.includes("SKU") ? "SKU column found" : "SKU column needed"}</span>
                                        <span>{headers.includes("Quantity Available") ? "Quantity column found" : "Quantity Available column needed"}</span>
                                        <span>{selectedLocation === "ALL_LOCATIONS" ? "Location comes from file" : "Location selected in app"}</span>
                                    </div>
                                    {isProgressVisible && (
                                        <div className="progress-container">
                                            <ProgressBar progress={progress} size="small" />
                                            <s-text variant="bodyLg">
                                                {isUpdatingShopify ? "Processing inventory updates..." : "Checking inventory changes..."}
                                            </s-text>
                                        </div>
                                    )}
                                    {sampleRows.length > 0 && sampleHeaders.length > 0 && (
                                        <div className="sample-table-wrap">
                                            <table className="sample-table">
                                                <thead>
                                                    <tr>
                                                        {sampleHeaders.map((header) => <th key={header}>{header}</th>)}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {sampleRows.map((row, rowIndex) => (
                                                        <tr key={rowIndex}>
                                                            {sampleHeaders.map((header) => (
                                                                <td key={header}>{row[header]?.toString() || "-"}</td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                    <div className="button-row">
                                        <s-button
                                            variant="primary"
                                            onClick={() => submitImport(true)}
                                            loading={isLoading ? "true" : undefined}
                                            disabled={!canPreview ? "true" : undefined}
                                        >
                                            Preview Changes
                                        </s-button>
                                    </div>
                                </s-section>
                            </div>
                        )}

                        {displayResults && !isProgressVisible && (
                            <>
                                <div className="section-gap">
                                    <s-section heading="Import Results">
                                        <div className="summary-grid">
                                            <div className="summary-tile">
                                                <span>Total rows</span>
                                                <strong>{displayResults.total}</strong>
                                            </div>
                                            <div className="summary-tile">
                                                <span>Matched SKUs</span>
                                                <strong>{displayResults.counts?.matched || 0}</strong>
                                            </div>
                                            <div className="summary-tile">
                                                <span>{displayResults.dryRun ? "Ready to update" : "Updated"}</span>
                                                <strong>{displayResults.dryRun ? (displayResults.updatedRows?.length || 0) : displayResults.updated}</strong>
                                            </div>
                                            <div className="summary-tile">
                                                <span>Skipped</span>
                                                <strong>{displayResults.skippedRows?.length || 0}</strong>
                                            </div>
                                            <div className={`summary-tile ${displayResults.failedRows?.length > 0 ? "has-errors" : ""}`}>
                                                <span>Failed rows</span>
                                                <strong>{displayResults.failedRows?.length || 0}</strong>
                                            </div>
                                            <div className="summary-tile">
                                                <span>Missing in Shopify</span>
                                                <strong>{displayResults.counts?.missingShopifySku || 0}</strong>
                                            </div>
                                        </div>
                                        {displayResults.dryRun && displayResults.updatedRows?.length > 0 && (
                                            <div className="button-row">
                                                <s-button onClick={downloadRollbackFile}>
                                                    Download Rollback
                                                </s-button>
                                                <s-button onClick={downloadResultReport}>
                                                    Download Preview Report
                                                </s-button>
                                                <s-button
                                                    variant="primary"
                                                    onClick={() => submitImport(false)}
                                                    loading={(isLoading || isUpdatingShopify) ? "true" : undefined}
                                                >
                                                    Confirm and Update Shopify
                                                </s-button>
                                            </div>
                                        )}
                                        {!displayResults.dryRun && (
                                            <div className="button-row">
                                                <s-button onClick={downloadResultReport}>
                                                    Download Update Report
                                                </s-button>
                                                <s-button onClick={downloadRollbackFile}>
                                                    Download Rollback
                                                </s-button>
                                            </div>
                                        )}
                                    </s-section>
                                </div>

                                {displayResults.updatedRows?.length > 0 && (
                                    <div className="section-gap">
                                        <s-section heading={displayResults.dryRun ? "Rows Ready to Update" : "Updated Rows"}>
                                            <s-table>
                                                <s-table-header-row>
                                                    {tableColumns(displayResults.updatedRows[0] || {}).map((key) => (
                                                        <s-table-header key={key}>{key}</s-table-header>
                                                    ))}
                                                </s-table-header-row>
                                                <s-table-body>
                                                    {displayResults.updatedRows
                                                        .slice((updatedPage - 1) * updatedRowsPerPage, updatedPage * updatedRowsPerPage)
                                                        .map((row, index) => (
                                                            <s-table-row key={index}>
                                                                {tableColumns(displayResults.updatedRows[0] || {}).map((key, cellIndex) => (
                                                                    <s-table-cell key={cellIndex}>
                                                                        {row[key]?.toString() || '-'}
                                                                    </s-table-cell>
                                                                ))}
                                                            </s-table-row>
                                                        ))}
                                                </s-table-body>
                                            </s-table>
                                            {displayResults.updatedRows.length > updatedRowsPerPage && (
                                                <Pagination
                                                    hasPrevious={updatedPage > 1}
                                                    onPrevious={() => setUpdatedPage(updatedPage - 1)}
                                                    hasNext={updatedPage < Math.ceil(displayResults.updatedRows.length / updatedRowsPerPage)}
                                                    onNext={() => setUpdatedPage(updatedPage + 1)}
                                                    type="table"
                                                    label={`${((updatedPage - 1) * updatedRowsPerPage) + 1}-${Math.min(updatedPage * updatedRowsPerPage, displayResults.updatedRows.length)} of ${displayResults.updatedRows.length}`}
                                                />
                                            )}
                                        </s-section>
                                    </div>
                                )}

                                {displayResults.failedRows?.length > 0 && (
                                    <div className="section-gap">
                                        <s-section heading={`Failed Rows (${displayResults.failedRows.length})`}>
                                            <s-table>
                                                <s-table-header-row>
                                                    {tableColumns(displayResults.failedRows[0] || {}).map((key) => (
                                                        <s-table-header key={key}>{key}</s-table-header>
                                                    ))}
                                                </s-table-header-row>
                                                <s-table-body>
                                                    {displayResults.failedRows
                                                        .slice((failedPage - 1) * failedRowsPerPage, failedPage * failedRowsPerPage)
                                                        .map((row, index) => (
                                                            <s-table-row key={index}>
                                                                {tableColumns(displayResults.failedRows[0] || {}).map((key, cellIndex) => (
                                                                    <s-table-cell key={cellIndex}>
                                                                        {row[key]?.toString() || '-'}
                                                                    </s-table-cell>
                                                                ))}
                                                            </s-table-row>
                                                        ))}
                                                </s-table-body>
                                            </s-table>
                                            {displayResults.failedRows.length > failedRowsPerPage && (
                                                <Pagination
                                                    hasPrevious={failedPage > 1}
                                                    onPrevious={() => setFailedPage(failedPage - 1)}
                                                    hasNext={failedPage < Math.ceil(displayResults.failedRows.length / failedRowsPerPage)}
                                                    onNext={() => setFailedPage(failedPage + 1)}
                                                    type="table"
                                                    label={`${((failedPage - 1) * failedRowsPerPage) + 1}-${Math.min(failedPage * failedRowsPerPage, displayResults.failedRows.length)} of ${displayResults.failedRows.length}`}
                                                />
                                            )}
                                        </s-section>
                                    </div>
                                )}

                                {displayResults.skippedRows?.length > 0 && (
                                    <div className="section-gap page-bottom">
                                        <s-section heading={`Skipped Rows (${displayResults.skippedRows.length})`}>
                                            <s-table>
                                                <s-table-header-row>
                                                    {tableColumns(displayResults.skippedRows[0] || {}).map((key) => (
                                                        <s-table-header key={key}>{key}</s-table-header>
                                                    ))}
                                                </s-table-header-row>
                                                <s-table-body>
                                                    {displayResults.skippedRows
                                                        .slice((skippedPage - 1) * skippedRowsPerPage, skippedPage * skippedRowsPerPage)
                                                        .map((row, index) => (
                                                            <s-table-row key={index}>
                                                                {tableColumns(displayResults.skippedRows[0] || {}).map((key, cellIndex) => (
                                                                    <s-table-cell key={cellIndex}>
                                                                        {row[key]?.toString() || '-'}
                                                                    </s-table-cell>
                                                                ))}
                                                            </s-table-row>
                                                        ))}
                                                </s-table-body>
                                            </s-table>
                                            {displayResults.skippedRows.length > skippedRowsPerPage && (
                                                <Pagination
                                                    hasPrevious={skippedPage > 1}
                                                    onPrevious={() => setSkippedPage(skippedPage - 1)}
                                                    hasNext={skippedPage < Math.ceil(displayResults.skippedRows.length / skippedRowsPerPage)}
                                                    onNext={() => setSkippedPage(skippedPage + 1)}
                                                    type="table"
                                                    label={`${((skippedPage - 1) * skippedRowsPerPage) + 1}-${Math.min(skippedPage * skippedRowsPerPage, displayResults.skippedRows.length)} of ${displayResults.skippedRows.length}`}
                                                />
                                            )}
                                        </s-section>
                                    </div>
                                )}
                            </>
                        )}
                    </div>

                    <aside className="growth-aside" aria-label="Growth Digital Shopify support">
                        <s-section heading="Inventory Tips">
                            <div className="growth-panel">
                                <div className="growth-brand">
                                    <span className="growth-brand-icon" aria-hidden="true">GD</span>
                                    <p className="growth-kicker">Growth Digital</p>
                                </div>
                                <p className="growth-title">Export first, then import from a clean backup.</p>
                                <p className="panel-copy">Use the export file as your base, preview changes, download a rollback file, and keep the SKU column unchanged.</p>
                                <div className="growth-list">
                                    <span>SKU is required</span>
                                    <span>CSV and Excel supported</span>
                                    <span>All locations need location names</span>
                                </div>
                            </div>
                        </s-section>
                    </aside>
                </div>
            </div>
        </s-page>
    );
}
