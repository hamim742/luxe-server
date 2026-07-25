import type { Request, Response } from "express";
import catchAsync from "../../utils/catchAsync.js";
import prisma from "../../db/prisma.js";
import { createInvoicePDF } from "../../utils/pdfGenerator.js";
import { sendOrderConfirmationEmail, sendOrderCancellationEmails, sendOrderStatusUpdateEmail } from "../../utils/emailSender.js";

const createOrder = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const {
    customerName,
    customerEmail,
    total,
    paymentStatus,
    fulfillmentStatus,
    items,
    paymentMethod,
    deliveryMethod,
    estimatedDelivery,
    phone,
    addressLine1,
    addressLine2,
    city,
    state,
    zipCode,
    couponCode,
    transactionId,
  } = req.body;

  const errors: Record<string, string> = {};

  // Validations
  if (!customerName || customerName.trim() === "") {
    errors.customerName = "Customer name is required.";
  }
  if (!customerEmail || customerEmail.trim() === "") {
    errors.customerEmail = "Customer email is required.";
  }
  const parsedTotal = parseFloat(total);
  if (isNaN(parsedTotal) || parsedTotal < 0) {
    errors.total = "Total must be a non-negative number.";
  }

  // Verify coupon is not used multiple times by this user
  if (couponCode && typeof couponCode === "string" && couponCode.trim() !== "") {
    const codeUpper = couponCode.trim().toUpperCase();
    const existingOrderWithCoupon = await prisma.order.findFirst({
      where: {
        customerEmail: customerEmail.trim(),
        couponCode: codeUpper,
      },
    });

    if (existingOrderWithCoupon) {
      errors.coupon = "You have already redeemed this coupon.";
    }
  }

  // Return validation error response if any
  if (Object.keys(errors).length > 0) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors,
    });
    return;
  }

  // Generate sequential order number based on total count of existing orders
  const orderCount = await prisma.order.count();
  const nextOrderNum = (orderCount + 1).toString().padStart(3, "0");
  const orderId = `ORD-${nextOrderNum}`;

  // Formatted date string to match client presentation
  const formattedDate = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const order = await prisma.order.create({
    data: {
      orderId,
      date: formattedDate,
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim(),
      total: parsedTotal,
      paymentStatus: paymentStatus || "Pending",
      paymentMethod: paymentMethod || "card",
      fulfillmentStatus: fulfillmentStatus || "Processing",
      items: items || null,
      phone: phone || null,
      addressLine1: addressLine1 || null,
      addressLine2: addressLine2 || null,
      city: city || null,
      state: state || null,
      zipCode: zipCode || null,
      couponCode: couponCode || null,
      transactionId: transactionId || null,
    },
  });

  // Create admin push notification for new order
  await prisma.notification.create({
    data: {
      title: "New Order Received",
      message: `Order ${orderId} has been placed by ${customerName.trim()} for ৳${parsedTotal.toLocaleString()}`,
      type: "new_order",
      isRead: false,
    },
  }).catch((err) => console.error("Failed to create new order notification:", err));

  // Generate sequential invoice number based on total count of existing invoices
  const invoiceCount = await prisma.invoice.count();
  const nextInvNum = (invoiceCount + 1).toString().padStart(3, "0");
  const invoiceNumber = `INV-${nextInvNum}`;

  await prisma.invoice.create({
    data: {
      invoiceNumber,
      orderId: order.id,
      amount: parsedTotal,
      status: paymentStatus === "Paid" ? "Paid" : "Unpaid",
    },
  });

  // Log transaction for bKash if not already logged (Stripe logs during payment intent creation)
  if (paymentStatus === "Paid" && paymentMethod === "bkash") {
    await prisma.transaction.create({
      data: {
        transactionId: `#TRX-${Math.floor(10000 + Math.random() * 90000)}`,
        date: formattedDate,
        time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true }),
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim(),
        amount: parsedTotal,
        status: "Succeeded",
        method: "bKash",
      },
    });
  }

  // Increment coupon usage if coupon code was used
  if (couponCode && typeof couponCode === "string" && couponCode.trim() !== "") {
    try {
      const coupon = await prisma.coupon.findUnique({
        where: { code: couponCode.trim().toUpperCase() },
      });
      if (coupon) {
        await prisma.coupon.update({
          where: { id: coupon.id },
          data: {
            usageUsed: {
              increment: 1,
            },
          },
        });
      }
    } catch (err) {
      console.error("Failed to update coupon usage count:", err);
    }
  }

  // Send confirmation email asynchronously (do not block client response)
  sendOrderConfirmationEmail(
    customerEmail.trim(),
    customerName.trim(),
    order,
    invoiceNumber,
    paymentMethod || "Stripe (Card)",
    deliveryMethod || "standard",
    estimatedDelivery || "3-5 Days"
  ).catch((mailErr) => {
    console.error("Failed to send order confirmation email:", mailErr);
  });

  res.status(201).json({
    success: true,
    message: "Order created successfully",
    data: order,
  });
});

const getAllOrders = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const { page = 1, limit = 10, search = "", status = "All", payment = "All", dateRange = "All" } = req.query;

  const parsedPage = Math.max(1, parseInt(page as string, 10));
  const parsedLimit = Math.max(1, parseInt(limit as string, 10));

  // Auto seed orders if table is empty
  const count = await prisma.order.count();
  if (count === 0 && !search && status === "All" && payment === "All" && dateRange === "All") {
    // Seed default orders to keep UI populated on first load
    const defaultOrders = [
      {
        orderId: "ORD-001",
        date: "Oct 24, 2024",
        customerName: "Alex Thompson",
        customerEmail: "alex.t@example.com",
        total: 249.0,
        paymentStatus: "Paid",
        fulfillmentStatus: "Shipped",
        createdAt: new Date("2024-10-24T12:00:00Z")
      },
      {
        orderId: "ORD-002",
        date: "Oct 23, 2024",
        customerName: "Sarah Jenkins",
        customerEmail: "s.jenkins@provider.net",
        total: 1120.5,
        paymentStatus: "Pending",
        fulfillmentStatus: "Processing",
        createdAt: new Date("2024-10-23T12:00:00Z")
      },
      {
        orderId: "ORD-003",
        date: "Oct 22, 2024",
        customerName: "Michael Chen",
        customerEmail: "m.chen@example.com",
        total: 85.0,
        paymentStatus: "Paid",
        fulfillmentStatus: "Delivered",
        createdAt: new Date("2024-10-22T12:00:00Z")
      },
      {
        orderId: "ORD-004",
        date: "Oct 21, 2024",
        customerName: "Emily Davis",
        customerEmail: "emily.d@provider.net",
        total: 430.0,
        paymentStatus: "Paid",
        fulfillmentStatus: "Canceled",
        createdAt: new Date("2024-10-21T12:00:00Z")
      },
      {
        orderId: "ORD-005",
        date: "Oct 20, 2024",
        customerName: "James Wilson",
        customerEmail: "j.wilson@tech.com",
        total: 150.0,
        paymentStatus: "Refunded",
        fulfillmentStatus: "Returned",
        createdAt: new Date("2024-10-20T12:00:00Z")
      }
    ];

    await prisma.order.createMany({
      data: defaultOrders
    });
  }

  const where: any = {};

  // Search filter
  if (search) {
    const searchString = String(search).trim();
    where.OR = [
      { orderId: { contains: searchString, mode: "insensitive" } },
      { customerName: { contains: searchString, mode: "insensitive" } },
      { customerEmail: { contains: searchString, mode: "insensitive" } },
    ];
  }

  // Fulfillment status filter
  if (status !== "All") {
    where.fulfillmentStatus = status;
  }

  // Payment status filter
  if (payment !== "All") {
    where.paymentStatus = payment;
  }

  // Date range filter
  if (dateRange !== "All") {
    const now = new Date();
    if (dateRange === "Today") {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      where.createdAt = { gte: todayStart };
    } else if (dateRange === "Yesterday") {
      const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
      const yesterdayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      where.createdAt = { gte: yesterdayStart, lt: yesterdayEnd };
    } else if (dateRange === "7d") {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      where.createdAt = { gte: sevenDaysAgo };
    } else if (dateRange === "30d") {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      where.createdAt = { gte: thirtyDaysAgo };
    }
  }

  const totalCount = await prisma.order.count({ where });
  const orders = await prisma.order.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (parsedPage - 1) * parsedLimit,
    take: parsedLimit,
  });

  res.status(200).json({
    success: true,
    data: orders,
    meta: {
      total: totalCount,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(totalCount / parsedLimit),
    }
  });
});

const updateOrder = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const {
    customerName,
    customerEmail,
    total,
    paymentStatus,
    fulfillmentStatus,
    paymentMethod,
    phone,
    addressLine1,
    addressLine2,
    city,
    state,
    zipCode,
    transactionId,
  } = req.body;

  // Retrieve the existing order first
  const existingOrder = await prisma.order.findUnique({
    where: { id: id },
  });

  if (!existingOrder) {
    res.status(404).json({
      success: false,
      message: "Order not found",
    });
    return;
  }

  const errors: Record<string, string> = {};

  // Validations (only if provided, or fallback to existing values)
  const nameToSave = customerName !== undefined ? customerName : existingOrder.customerName;
  const emailToSave = customerEmail !== undefined ? customerEmail : existingOrder.customerEmail;
  const totalToSave = total !== undefined ? parseFloat(total) : existingOrder.total;

  if (!nameToSave || nameToSave.trim() === "") {
    errors.customerName = "Customer name is required.";
  }
  if (!emailToSave || emailToSave.trim() === "") {
    errors.customerEmail = "Customer email is required.";
  }
  if (isNaN(totalToSave) || totalToSave < 0) {
    errors.total = "Total must be a non-negative number.";
  }

  // Sequential order status transition state machine validation
  if (fulfillmentStatus !== undefined && fulfillmentStatus !== existingOrder.fulfillmentStatus) {
    const current = existingOrder.fulfillmentStatus;
    const target = fulfillmentStatus;

    if (current === "Canceled") {
      errors.fulfillmentStatus = "Order is already cancelled and cannot be updated.";
    } else if (current === "Returned") {
      errors.fulfillmentStatus = "Order is already returned and cannot be updated.";
    } else if (current === "Delivered") {
      if (target !== "Returned") {
        errors.fulfillmentStatus = "Delivered orders can only transition to Returned status.";
      }
    } else if (current === "Shipped") {
      if (target !== "Delivered") {
        errors.fulfillmentStatus = "Shipped orders can only transition to Delivered status.";
      }
    } else if (current === "Packed") {
      if (target !== "Shipped" && target !== "Canceled") {
        errors.fulfillmentStatus = "Packed orders can only transition to Shipped or Canceled status.";
      }
    } else if (current === "Confirmed") {
      if (target !== "Packed" && target !== "Canceled") {
        errors.fulfillmentStatus = "Confirmed orders can only transition to Packed or Canceled status.";
      }
    } else if (current === "Processing") {
      if (target !== "Confirmed" && target !== "Canceled") {
        errors.fulfillmentStatus = "Processing orders can only transition to Confirmed or Canceled status.";
      }
    }
  }

  // Return validation error response if any
  if (Object.keys(errors).length > 0) {
    res.status(400).json({
      success: false,
      message: "Validation failed",
      errors,
    });
    return;
  }

  const updateData: Record<string, any> = {
    customerName: nameToSave.trim(),
    customerEmail: emailToSave.trim(),
    total: totalToSave,
    paymentStatus: paymentStatus !== undefined ? paymentStatus : existingOrder.paymentStatus,
    paymentMethod: paymentMethod !== undefined ? paymentMethod : existingOrder.paymentMethod,
    fulfillmentStatus: fulfillmentStatus !== undefined ? fulfillmentStatus : existingOrder.fulfillmentStatus,
    phone: phone !== undefined ? phone : existingOrder.phone,
    addressLine1: addressLine1 !== undefined ? addressLine1 : existingOrder.addressLine1,
    addressLine2: addressLine2 !== undefined ? addressLine2 : existingOrder.addressLine2,
    city: city !== undefined ? city : existingOrder.city,
    state: state !== undefined ? state : existingOrder.state,
    zipCode: zipCode !== undefined ? zipCode : existingOrder.zipCode,
    transactionId: transactionId !== undefined ? transactionId : existingOrder.transactionId,
  };

  const updatedOrder = await prisma.order.update({
    where: { id: id },
    data: updateData,
  });

  // Check if status has changed
  if (fulfillmentStatus && fulfillmentStatus !== existingOrder.fulfillmentStatus) {
    if (fulfillmentStatus === "Canceled") {
      // Create admin notification for cancelled order
      await prisma.notification.create({
        data: {
          title: "Order Cancelled",
          message: `Order ${updatedOrder.orderId} has been cancelled.`,
          type: "cancelled_order",
          isRead: false,
        },
      }).catch((err) => console.error("Failed to create cancellation notification:", err));

      sendOrderCancellationEmails(updatedOrder).catch((mailErr) => {
        console.error("Failed to send order cancellation emails:", mailErr);
      });
    } else {
      sendOrderStatusUpdateEmail(updatedOrder, fulfillmentStatus).catch((mailErr) => {
        console.error("Failed to send order status update email:", mailErr);
      });
    }
  }

  res.status(200).json({
    success: true,
    message: "Order updated successfully",
    data: updatedOrder,
  });
});

const deleteOrder = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;

  await prisma.order.delete({
    where: { id: id },
  });

  res.status(200).json({
    success: true,
    message: "Order deleted successfully",
  });
});

const downloadInvoice = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const order = await prisma.order.findUnique({
    where: { id: id as string },
    include: {
      invoice: true,
    },
  });

  if (!order) {
    res.status(404).json({
      success: false,
      message: "Order not found",
    });
    return;
  }

  let invoice = (order as any).invoice;
  if (!invoice) {
    // Generate sequential invoice number dynamically if not exists
    const invoiceCount = await prisma.invoice.count();
    const nextInvNum = (invoiceCount + 1).toString().padStart(3, "0");
    const invoiceNumber = `INV-${nextInvNum}`;
    invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        orderId: order.id,
        amount: order.total,
        status: order.paymentStatus === "Paid" ? "Paid" : "Unpaid",
      },
    });
  }

  const pdfBuffer = await createInvoicePDF(order, invoice.invoiceNumber);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=invoice-${invoice.invoiceNumber}.pdf`);
  res.send(pdfBuffer);
});

const getDashboardStats = catchAsync(async (req: Request, res: Response): Promise<void> => {
  const now = new Date();
  
  // Start of today (midnight)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  // Helper function to calculate stats for a period
  const getPeriodStats = async (start: Date, end: Date, prevStart: Date, prevEnd: Date) => {
    // 1. Revenue
    const periodOrders = await prisma.order.findMany({
      where: {
        createdAt: { gte: start, lt: end },
        NOT: { fulfillmentStatus: { in: ["Canceled", "Cancelled"] } }
      },
      select: { total: true }
    });
    const totalRevenue = periodOrders.reduce((sum, o) => sum + o.total, 0);

    const prevOrders = await prisma.order.findMany({
      where: {
        createdAt: { gte: prevStart, lt: prevEnd },
        NOT: { fulfillmentStatus: { in: ["Canceled", "Cancelled"] } }
      },
      select: { total: true }
    });
    const prevRevenue = prevOrders.reduce((sum, o) => sum + o.total, 0);
    const revenueGrowth = prevRevenue === 0 ? (totalRevenue > 0 ? 100 : 0) : ((totalRevenue - prevRevenue) / prevRevenue) * 100;

    // 2. Orders
    const totalOrders = await prisma.order.count({
      where: { createdAt: { gte: start, lt: end } }
    });
    const prevOrdersCount = await prisma.order.count({
      where: { createdAt: { gte: prevStart, lt: prevEnd } }
    });
    const ordersGrowth = prevOrdersCount === 0 ? (totalOrders > 0 ? 100 : 0) : ((totalOrders - prevOrdersCount) / prevOrdersCount) * 100;

    // 3. Active products count (snapshot is always current total, growth is based on period additions)
    const activeProducts = await prisma.product.count({
      where: { status: "Published" }
    });
    const periodProductsCount = await prisma.product.count({
      where: { createdAt: { gte: start, lt: end }, status: "Published" }
    });
    const prevPeriodProductsCount = await prisma.product.count({
      where: { createdAt: { gte: prevStart, lt: prevEnd }, status: "Published" }
    });
    const productsGrowth = prevPeriodProductsCount === 0 ? (periodProductsCount > 0 ? 100 : 0) : ((periodProductsCount - prevPeriodProductsCount) / prevPeriodProductsCount) * 100;

    // 4. Users (snapshot is always current total, growth is based on period additions)
    const registeredUsers = await prisma.user.count();
    const periodUsersCount = await prisma.user.count({
      where: { createdAt: { gte: start, lt: end } }
    });
    const prevPeriodUsersCount = await prisma.user.count({
      where: { createdAt: { gte: prevStart, lt: prevEnd } }
    });
    const usersGrowth = prevPeriodUsersCount === 0 ? (periodUsersCount > 0 ? 100 : 0) : ((periodUsersCount - prevPeriodUsersCount) / prevPeriodUsersCount) * 100;

    return {
      totalRevenue,
      revenueGrowth,
      totalOrders,
      ordersGrowth,
      activeProducts,
      productsGrowth,
      registeredUsers,
      usersGrowth
    };
  };

  const todayStats = await getPeriodStats(todayStart, now, yesterdayStart, todayStart);
  const sevenDaysStats = await getPeriodStats(sevenDaysAgo, now, fourteenDaysAgo, sevenDaysAgo);
  const thirtyDaysStats = await getPeriodStats(thirtyDaysAgo, now, sixtyDaysAgo, thirtyDaysAgo);

  // All non-cancelled orders for top products / chart calculations
  const allOrdersList = await prisma.order.findMany({
    where: {
      NOT: {
        fulfillmentStatus: { in: ["Canceled", "Cancelled"] }
      }
    }
  });

  // Daily average revenue over the last 30 days
  const dailyAverage = thirtyDaysStats.totalRevenue / 30;

  // Recent 5 orders
  const recentOrders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 5
  });

  // Top products calculation based on sales quantity (all time)
  const productSalesMap: Record<string, { quantity: number; totalSales: number }> = {};
  
  allOrdersList.forEach(order => {
    if (order.items) {
      try {
        const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
        if (Array.isArray(items)) {
          items.forEach((item: any) => {
            const id = item.id || item.productId;
            if (id) {
              const qty = Number(item.quantity) || 0;
              const price = Number(item.price) || 0;
              if (!productSalesMap[id]) {
                productSalesMap[id] = { quantity: 0, totalSales: 0 };
              }
              productSalesMap[id].quantity += qty;
              productSalesMap[id].totalSales += qty * price;
            }
          });
        }
      } catch (err) {
        console.error("Error parsing order items for topProducts stats:", err);
      }
    }
  });

  const sortedProductIds = Object.keys(productSalesMap).sort(
    (a, b) => (productSalesMap[b]?.quantity || 0) - (productSalesMap[a]?.quantity || 0)
  );

  const top3ProductIds = sortedProductIds.slice(0, 3);
  let topProductsList: any[] = [];
  if (top3ProductIds.length > 0) {
    const productsFromDb = await prisma.product.findMany({
      where: { id: { in: top3ProductIds } }
    });
    topProductsList = productsFromDb.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category,
      inventoryCount: p.inventoryCount,
      image: p.image,
      salesCount: productSalesMap[p.id]?.quantity || 0
    })).sort((a, b) => b.salesCount - a.salesCount);
  }

  // Backfill with published products if less than 3 top products
  if (topProductsList.length < 3) {
    const existingIds = topProductsList.map(p => p.id);
    const backupProducts = await prisma.product.findMany({
      where: {
        status: "Published",
        id: { notIn: existingIds }
      },
      take: 3 - topProductsList.length
    });
    const backfilled = backupProducts.map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      category: p.category,
      inventoryCount: p.inventoryCount,
      image: p.image,
      salesCount: 0
    }));
    topProductsList = [...topProductsList, ...backfilled];
  }

  // Generate chartData mapping
  const getChartDataMap = () => {
    // 1. Today
    const todayLabels: string[] = [];
    const todayMap: Record<string, { Revenue: number; Orders: number }> = {};
    for (let i = 11; i >= 0; i--) {
      const hour = new Date();
      hour.setHours(hour.getHours() - i * 2);
      const hourString = hour.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
      todayLabels.push(hourString);
      todayMap[hourString] = { Revenue: 0, Orders: 0 };
    }
    
    allOrdersList.forEach(ord => {
      const d = new Date(ord.createdAt);
      if (d.toDateString() === now.toDateString()) {
        const hour = d.getHours();
        const bracket = Math.floor(hour / 2) * 2;
        const bracketDate = new Date();
        bracketDate.setHours(bracket, 0, 0, 0);
        const keyString = bracketDate.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
        if (todayMap[keyString]) {
          todayMap[keyString].Revenue += ord.total;
          todayMap[keyString].Orders += 1;
        }
      }
    });

    const todayList = todayLabels.map(name => ({
      name,
      Revenue: todayMap[name]?.Revenue || 0,
      Orders: todayMap[name]?.Orders || 0
    }));

    // 2. 7d
    const sevenDaysLabels: string[] = [];
    const sevenDaysMap: Record<string, { Revenue: number; Orders: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateString = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      sevenDaysLabels.push(dateString);
      sevenDaysMap[dateString] = { Revenue: 0, Orders: 0 };
    }
    
    allOrdersList.forEach(ord => {
      const d = new Date(ord.createdAt);
      const dateString = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (sevenDaysMap[dateString]) {
        sevenDaysMap[dateString].Revenue += ord.total;
        sevenDaysMap[dateString].Orders += 1;
      }
    });

    const sevenDaysList = sevenDaysLabels.map(name => ({
      name,
      Revenue: sevenDaysMap[name]?.Revenue || 0,
      Orders: sevenDaysMap[name]?.Orders || 0
    }));

    // 3. 30d
    const thirtyDaysLabels: string[] = [];
    const thirtyDaysMap: Record<string, { Revenue: number; Orders: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateString = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      thirtyDaysLabels.push(dateString);
      thirtyDaysMap[dateString] = { Revenue: 0, Orders: 0 };
    }
    
    allOrdersList.forEach(ord => {
      const d = new Date(ord.createdAt);
      const dateString = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      if (thirtyDaysMap[dateString]) {
        thirtyDaysMap[dateString].Revenue += ord.total;
        thirtyDaysMap[dateString].Orders += 1;
      }
    });

    const thirtyDaysList = thirtyDaysLabels.map(name => ({
      name,
      Revenue: thirtyDaysMap[name]?.Revenue || 0,
      Orders: thirtyDaysMap[name]?.Orders || 0
    }));

    return {
      "Today": todayList,
      "7d": sevenDaysList,
      "30d": thirtyDaysList
    };
  };

  res.status(200).json({
    success: true,
    data: {
      timeframeStats: {
        "Today": todayStats,
        "7d": sevenDaysStats,
        "30d": thirtyDaysStats
      },
      dailyAverage,
      recentOrders,
      topProducts: topProductsList,
      chartData: getChartDataMap()
    }
  });
});

export const OrderController = {
  createOrder,
  getAllOrders,
  updateOrder,
  deleteOrder,
  downloadInvoice,
  getDashboardStats,
};
